// TRIAGE_MODEL, for jobs the heuristics can't classify (SPEC §6.2 step 6, §7.5): a self-hosted
// model on Ollama (D11). The answer is constrained by a JSON schema, validated again with zod, one
// retry on an invalid answer, and every call recorded with its tokens. Self-hosted calls cost no
// money per token, so their cost is recorded as 0.
import {
  MODEL_CONFIDENCE_CAP,
  TRIAGE_OUTPUT_JSON_SCHEMA,
  TRIAGE_PROMPT_VERSION,
  buildTriagePrompt,
  triageOutputSchema,
  type Classification,
  type TriageOutput,
  type TriagePromptInput,
} from "@pipeheal/agent-core";
import type { ModelCallInput } from "@pipeheal/db";
import type { Logger } from "@pipeheal/shared/logger";
import { OllamaError, type OllamaChatResponse, type OllamaClient } from "./ollama";

export interface TriageModel {
  /** Null when no valid answer came back (after one retry) or the call failed. */
  classify(
    input: TriagePromptInput,
    record: (call: ModelCallInput) => Promise<void>,
  ): Promise<Classification | null>;
}

/**
 * Context window: the prompt (at most ~10K tokens, agent-core's caps) and the answer. Sized for a
 * 14B model on a 12 GB GPU: its KV cache grows with the context.
 */
export const TRIAGE_CONTEXT_TOKENS = 12_288;
// Classification is short; this leaves room for the summary and file list.
const MAX_ANSWER_TOKENS = 512;
const ATTEMPTS = 2;

/** The answer, when the model finished normally and it's valid; null otherwise. */
function parseAnswer(response: OllamaChatResponse): TriageOutput | null {
  if (response.done_reason !== undefined && response.done_reason !== "stop") return null;
  try {
    const parsed = triageOutputSchema.safeParse(JSON.parse(response.message.content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function triageModel(options: {
  client: OllamaClient;
  model: string;
  logger: Logger;
}): TriageModel {
  const { client, model, logger } = options;
  const base = {
    purpose: "triage",
    model,
    promptVersion: TRIAGE_PROMPT_VERSION,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };

  return {
    async classify(input, record) {
      const { system, user } = buildTriagePrompt(input);
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        let response: OllamaChatResponse;
        try {
          response = await client.chat({
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            format: TRIAGE_OUTPUT_JSON_SCHEMA,
            // Classification needs no long reasoning: answer directly, deterministically.
            think: false,
            options: {
              num_ctx: TRIAGE_CONTEXT_TOKENS,
              num_predict: MAX_ANSWER_TOKENS,
              temperature: 0,
            },
          });
        } catch (error) {
          if (!(error instanceof OllamaError)) throw error;
          await record({ ...base, inputTokens: 0, outputTokens: 0, outcome: "error" });
          logger.warn({ status: error.status, attempt, err: error }, "triage model call failed");
          return null;
        }
        const answer = parseAnswer(response);
        await record({
          ...base,
          inputTokens: response.prompt_eval_count ?? 0,
          outputTokens: response.eval_count ?? 0,
          outcome: answer === null ? "invalid" : "valid",
        });
        if (answer !== null) {
          // Below every heuristic: a log can't talk the model into outranking what code found.
          return { ...answer, confidence: Math.min(answer.confidence, MODEL_CONFIDENCE_CAP) };
        }
        logger.warn({ attempt, doneReason: response.done_reason }, "invalid triage model answer");
      }
      return null;
    },
  };
}
