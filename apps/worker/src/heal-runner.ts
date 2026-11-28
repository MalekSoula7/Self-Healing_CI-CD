// The healer's model turn (SPEC §7, P4.4) on the self-hosted HEAL_MODEL (D11) with a 16k context
// (D17). Each turn: check the edits the runner just reported against the policy, stop when a cap
// is reached, otherwise rebuild the conversation from the timeline and ask the model for its next
// tool calls. Everything the model returns is read by agent-core and validated again by the turns
// queue; the policy engine, not the prompt, is what enforces the rules.
import {
  HEAL_PROMPT_VERSION,
  HEAL_TOOLS,
  buildHealMessages,
  buildHealSystemPrompt,
  editViolations,
  healRuleLines,
  readToolCalls,
  renderRecentChanges,
  stopReason,
  type HealBrief,
  type TimelineEvent,
} from "@pipeheal/agent-core";
import { forSystem, recentChangesRecordSchema, retryFeedbackSchema, type Db } from "@pipeheal/db";
import { effectivePolicy, type EffectivePolicy } from "@pipeheal/policy";
import type { Logger } from "@pipeheal/shared/logger";
import { LIMITS, attemptCommandsSchema, toolCallSchema } from "@pipeheal/shared/protocol";
import type { OllamaChatResponse, OllamaClient, OllamaMessage } from "./ollama";
import type { ModelCallSummary, PolicyCheck, TurnResult, TurnRunner } from "./queues/turns";

/** HEAL_MODEL's context window (D17), and the room kept for its answer and thinking. */
export const HEAL_CONTEXT_TOKENS = 16_384;
export const HEAL_ANSWER_TOKENS = 4_096;
const EDIT_TOOLS = new Set(["apply_edit", "write_file"]);
const NUDGE =
  "Answer by calling exactly one of the tools: a next step, submit_fix when the fix is verified, or give_up with a diagnosis.";

export interface HealInputs {
  brief: HealBrief;
  policy: EffectivePolicy;
  /** When the session opened: the attempt's wall clock starts there. */
  startedAt: Date;
}

export interface HealRunnerDeps {
  client: OllamaClient;
  model: string;
  /** The attempt's brief and effective policy, or null when the attempt is gone. */
  load: (orgId: string, attemptId: string) => Promise<HealInputs | null>;
  logger: Logger;
  now?: () => Date;
}

/** The checks of this step's edit results: the runner returns each edit's cumulative diff. */
export function checkEdits(
  history: readonly TimelineEvent[],
  stepSeq: number,
  policy: EffectivePolicy,
): PolicyCheck[] {
  const editCalls = new Set<string>();
  for (const event of history) {
    if (event.type !== "TOOL_CALL") continue;
    const call = toolCallSchema.safeParse(event.payload);
    if (call.success && EDIT_TOOLS.has(call.data.tool)) editCalls.add(call.data.callId);
  }
  const checks: PolicyCheck[] = [];
  for (const event of history) {
    if (event.type !== "TOOL_RESULT" || event.stepSeq !== stepSeq) continue;
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null) continue;
    const { callId, ok, output } = payload as Record<string, unknown>;
    if (typeof callId !== "string" || ok !== true || typeof output !== "string") continue;
    if (!editCalls.has(callId)) continue;
    const check = editViolations(output, policy);
    // An unreadable diff gets no feedback: the check is guidance, the submission is rechecked.
    if (check.ok) checks.push({ callId, violations: check.violations.slice(0, 50) });
  }
  return checks;
}

/** One field of the model's final answer, within its share of the stored reason. */
const field = (text: string) => (text.length <= 1_200 ? text : `${text.slice(0, 1_197)}...`);

function summary(responses: OllamaChatResponse[], model: string, durationMs: number) {
  const last = responses.at(-1);
  const text = last?.message.content.trim() ?? "";
  const summary: ModelCallSummary = {
    model,
    promptVersion: HEAL_PROMPT_VERSION,
    inputTokens: responses.reduce((sum, r) => sum + (r.prompt_eval_count ?? 0), 0),
    outputTokens: responses.reduce((sum, r) => sum + (r.eval_count ?? 0), 0),
    durationMs,
    ...(text === "" ? {} : { text: text.slice(0, LIMITS.textChars) }),
  };
  return summary;
}

export function healTurnRunner(deps: HealRunnerDeps): TurnRunner {
  const now = deps.now ?? (() => new Date());
  return {
    async next({ orgId, attemptId, stepSeq, history }) {
      const inputs = await deps.load(orgId, attemptId);
      if (inputs === null) return { done: "stopped", reason: "the attempt's context is gone" };
      const { brief, policy, startedAt } = inputs;
      const timeline: TimelineEvent[] = history.map((event) => ({
        type: event.type,
        stepSeq: event.stepSeq,
        payload: event.payload,
      }));
      const policyChecks = checkEdits(timeline, stepSeq, policy);
      const withChecks: TimelineEvent[] = [
        ...timeline,
        ...policyChecks.map((check) => ({
          type: "POLICY_CHECK" as const,
          stepSeq,
          payload: check,
        })),
      ];
      const stop = stopReason({
        history: withChecks,
        limits: {
          maxModelTokens: policy.limits.maxModelTokensPerAttempt,
          maxWallClockMinutes: policy.limits.maxWallClockMinutes,
        },
        startedAt,
        now: now(),
      });
      if (stop !== null) return { done: "stopped", reason: stop, policyChecks };

      const rules = healRuleLines(policy);
      const { messages, overBudget } = buildHealMessages({
        systemPrompt: buildHealSystemPrompt(rules),
        brief,
        history: withChecks,
        tokenBudget: HEAL_CONTEXT_TOKENS - HEAL_ANSWER_TOKENS,
        repoRules: rules.repoFile,
      });
      // Ollama would cut an oversized prompt silently, wrappers and all (review H3).
      if (overBudget) {
        return {
          done: "stopped",
          reason: "the conversation no longer fits the context",
          policyChecks,
        };
      }
      const conversation: OllamaMessage[] = messages;
      const responses: OllamaChatResponse[] = [];
      const started = Date.now();
      // One nudge when the model answers without a usable call, then the loop stops.
      for (let attempt = 1; attempt <= 2; attempt++) {
        let response: OllamaChatResponse;
        try {
          response = await deps.client.chat({
            model: deps.model,
            messages: conversation,
            tools: HEAL_TOOLS,
            think: true,
            options: {
              num_ctx: HEAL_CONTEXT_TOKENS,
              num_predict: HEAL_ANSWER_TOKENS,
              temperature: 0.2,
            },
          });
        } catch (error) {
          // The first call's tokens still count against the cap (review L4).
          if (responses.length === 0) throw error;
          return {
            done: "stopped",
            reason: "the model call failed",
            model: summary(responses, deps.model, Date.now() - started),
            policyChecks,
          };
        }
        responses.push(response);
        const read = readToolCalls(response.message.tool_calls, response.message.content);
        const model = summary(responses, deps.model, Date.now() - started);
        // Counts only: the conversation stays out of the logs.
        deps.logger.info(
          {
            attemptId,
            stepSeq,
            attempt,
            kind: read.kind,
            inputTokens: response.prompt_eval_count ?? 0,
            outputTokens: response.eval_count ?? 0,
          },
          "heal model answered",
        );
        const result = ((): TurnResult | null => {
          switch (read.kind) {
            case "calls":
              return { toolCalls: read.calls, model, policyChecks };
            case "submit":
              return {
                done: "submit",
                // Each field keeps its share of the 4,000-character reason (review L2).
                reason: [
                  `Root cause: ${field(read.fix.rootCause)}`,
                  `Changes: ${field(read.fix.changes)}`,
                  `Verification: ${field(read.fix.verification)}`,
                  `Confidence: ${read.fix.confidence}`,
                ].join("\n"),
                // Structured too, for the PR body (P5.2); bounded like the reason's fields.
                fix: {
                  rootCause: field(read.fix.rootCause),
                  changes: field(read.fix.changes),
                  verification: field(read.fix.verification),
                  confidence: read.fix.confidence,
                },
                model,
                policyChecks,
              };
            case "give_up":
              return {
                done: "gave_up",
                reason: `${field(read.diagnosis)}\nCategory: ${read.category}\nNext step: ${field(read.suggestedNextStep)}`,
                model,
                policyChecks,
              };
            default:
              return null;
          }
        })();
        if (result !== null) return result;
        if (attempt === 2) {
          return { done: "stopped", reason: "the model didn't call a tool", model, policyChecks };
        }
        conversation.push(
          { role: "assistant", content: response.message.content },
          { role: "user", content: NUDGE },
        );
      }
      return { done: "stopped", reason: "the model didn't call a tool", policyChecks };
    },
  };
}

/** What a turn needs from the database: the brief (SPEC §7.1) and the effective policy. */
export async function loadHealInputs(
  db: Db,
  orgId: string,
  attemptId: string,
): Promise<HealInputs | null> {
  const system = await forSystem(db, orgId, "heal");
  const attempt = await system.attempts.brief(attemptId);
  if (attempt?.sessionOpenedAt == null) return null;
  const { failure } = attempt;
  const { repo } = failure;
  const commands = attemptCommandsSchema.safeParse(repo.commands);
  const recent = recentChangesRecordSchema.safeParse(failure.recentChanges);
  const policy = effectivePolicy(await system.policies.layers(repo.id)).policy;
  // A retry works from what CI said about the earlier fix, not from the original logs.
  const feedback =
    attempt.retryOfId === null ? null : retryFeedbackSchema.safeParse(attempt.feedback);
  return {
    startedAt: attempt.sessionOpenedAt,
    policy,
    brief: {
      repo: { fullName: repo.fullName, defaultBranch: repo.defaultBranch, language: repo.language },
      commands: commands.success ? commands.data : {},
      failingCheck: attempt.failingCheck,
      failure: {
        category: failure.category,
        summary: failure.summary,
        headBranch: failure.headBranch,
      },
      jobs:
        feedback === null
          ? failure.runs.flatMap((run) => run.jobs)
          : feedback.success
            ? feedback.data
            : [],
      ...(feedback === null ? {} : { previousFix: true }),
      recentChanges:
        recent.success && recent.data.base !== null
          ? renderRecentChanges(recent.data.changes)
          : null,
    },
  };
}
