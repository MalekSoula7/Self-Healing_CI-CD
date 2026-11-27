// The soft-rule judge on the self-hosted model (SPEC §8.7 step 3, P4.7). One call per judge rule
// over the server's own diff, one at a time like every model call; each answer is validated, with
// one retry. P5.1's submission check calls `judgeSubmission` after the static and behavioral
// checks pass. It fails closed: a rule past the cap, a diff too large to read whole, a call that
// fails or overflows the context, the deadline, or any error leaves rules unjudged, and an
// unjudged rule rejects the submission like a violation (agent-core's judgeDecision).
import {
  JUDGE_CONTEXT_TOKENS,
  JUDGE_JSON_SCHEMA,
  JUDGE_PROMPT_VERSION,
  buildJudgePrompt,
  judgeAnswerSchema,
  judgeDecision,
  judgeRulesOf,
  renderJudgeDiff,
  unjudged,
  verdictOf,
  type JudgeAnswer,
  type JudgeOutcome,
  type JudgeRule,
} from "@pipeheal/agent-core";
import type { Change, EffectivePolicy, LayerName } from "@pipeheal/policy";
import type { Logger } from "@pipeheal/shared/logger";
import { OllamaError, type OllamaChatResponse, type OllamaClient } from "./ollama";

/** One model call, for the attempt's record (SPEC §7.5: tokens are what's budgeted). */
export interface JudgeCall {
  ruleId: string;
  /** Rule IDs are unique within a layer only. */
  layer: LayerName;
  inputTokens: number;
  outputTokens: number;
  valid: boolean;
}

export interface JudgeReport {
  outcomes: JudgeOutcome[];
  calls: JudgeCall[];
  model: string;
  promptVersion: string;
}

export interface JudgeModel {
  /** Judges each rule against the rendered diff (agent-core's renderJudgeDiff). */
  judge(
    rules: readonly JudgeRule[],
    diff: string,
    options: { deadline: number },
  ): Promise<JudgeReport>;
}

/** Room for the reasoning (600 characters) and the JSON around it. */
const MAX_ANSWER_TOKENS = 400;
const ATTEMPTS = 2;
/** A retry at temperature 0 would mostly repeat the invalid answer. */
const RETRY_TEMPERATURE = 0.3;

function parseAnswer(response: OllamaChatResponse): JudgeAnswer | null {
  if (response.done_reason !== undefined && response.done_reason !== "stop") return null;
  try {
    const parsed = judgeAnswerSchema.safeParse(JSON.parse(response.message.content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Ollama silently drops the start of a prompt that overflows `num_ctx` and still answers "stop".
 * renderJudgeDiff's estimate is the guard; this is the backstop, from what Ollama counted
 * (P4.7 review H1). A cached prefix lowers the count, so it can only miss, never refuse wrongly.
 */
function mayHaveOverflowed(response: OllamaChatResponse): boolean {
  const input = response.prompt_eval_count;
  return input === undefined || input + MAX_ANSWER_TOKENS >= JUDGE_CONTEXT_TOKENS;
}

export function judgeModel(options: {
  client: OllamaClient;
  model: string;
  logger: Logger;
  /** For tests. */
  now?: () => number;
}): JudgeModel {
  const { client, model, logger } = options;
  const now = options.now ?? Date.now;

  async function judgeOne(
    rule: JudgeRule,
    diff: string,
    deadline: number,
    calls: JudgeCall[],
  ): Promise<JudgeOutcome> {
    const { system, user } = buildJudgePrompt(rule, diff);
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      if (now() >= deadline) return unjudged(rule, "the judge ran out of time");
      let response: OllamaChatResponse;
      try {
        response = await client.chat({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          format: JUDGE_JSON_SCHEMA,
          think: false,
          options: {
            num_ctx: JUDGE_CONTEXT_TOKENS,
            num_predict: MAX_ANSWER_TOKENS,
            temperature: attempt === 1 ? 0 : RETRY_TEMPERATURE,
          },
        });
      } catch (error) {
        if (!(error instanceof OllamaError)) throw error;
        // Recorded too: a call that timed out may have used the GPU all the same.
        calls.push({
          ruleId: rule.id,
          layer: rule.layer,
          inputTokens: 0,
          outputTokens: 0,
          valid: false,
        });
        logger.warn(
          { ruleId: rule.id, layer: rule.layer, status: error.status, attempt },
          "judge model call failed",
        );
        return unjudged(rule, "the model couldn't be reached");
      }
      const overflowed = mayHaveOverflowed(response);
      const answer = overflowed ? null : parseAnswer(response);
      const call = {
        ruleId: rule.id,
        layer: rule.layer,
        inputTokens: response.prompt_eval_count ?? 0,
        outputTokens: response.eval_count ?? 0,
        valid: answer !== null,
      };
      calls.push(call);
      // IDs and counts only: the diff, the rule and the reasoning stay out of the logs.
      logger.info({ ...call, attempt, overflowed }, "judge model answered");
      if (overflowed) return unjudged(rule, "the change didn't fit the model's context");
      if (answer !== null) return verdictOf(rule, answer);
    }
    return unjudged(rule, "the model gave no valid answer");
  }

  return {
    async judge(rules, diff, { deadline }) {
      const outcomes: JudgeOutcome[] = [];
      const calls: JudgeCall[] = [];
      // In order, one at a time: the calls share the diff's prefix in Ollama's cache.
      for (const rule of rules) outcomes.push(await judgeOne(rule, diff, deadline, calls));
      return { outcomes, calls, model, promptVersion: JUDGE_PROMPT_VERSION };
    },
  };
}

export interface JudgeSubmissionResult {
  report: JudgeReport;
  decision: ReturnType<typeof judgeDecision>;
}

/**
 * The judge over a submission: every judge rule of the effective policy against the server's
 * own changes, by `deadline` (epoch ms). The single entry point, so no caller can forget a step
 * that keeps it failing closed (P4.7 review M1).
 */
export async function judgeSubmission(
  judge: JudgeModel,
  input: { policy: EffectivePolicy; changes: readonly Change[]; deadline: number },
  logger: Logger,
): Promise<JudgeSubmissionResult> {
  const { rules, skipped } = judgeRulesOf(input.policy);
  const expected = [...rules, ...skipped];
  const fail = (rule: JudgeRule, reason: string) => unjudged(rule, reason);
  const capped = skipped.map((rule) => fail(rule, "past the judge's rule cap"));
  let report: JudgeReport = {
    outcomes: [],
    calls: [],
    model: "",
    promptVersion: JUDGE_PROMPT_VERSION,
  };
  if (rules.length > 0) {
    const diff = renderJudgeDiff(input.changes);
    if (!diff.ok) {
      report = { ...report, outcomes: rules.map((rule) => fail(rule, diff.reason)) };
    } else {
      try {
        report = await judge.judge(rules, diff.text, { deadline: input.deadline });
      } catch (error) {
        logger.error({ err: error, rules: rules.length }, "the judge failed");
        report = { ...report, outcomes: rules.map((rule) => fail(rule, "the judge failed")) };
      }
    }
  }
  report = { ...report, outcomes: [...report.outcomes, ...capped] };
  return { report, decision: judgeDecision(expected, report.outcomes) };
}
