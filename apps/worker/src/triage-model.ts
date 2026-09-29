// TRIAGE_MODEL, for jobs the heuristics can't classify (SPEC §6.2 step 6, §7.5): structured
// outputs, validated again with zod, one retry on an invalid answer, and every call recorded with
// its tokens and cost (prices come from config, never code).
import Anthropic from "@anthropic-ai/sdk";
import {
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
import { z } from "zod";
import { callCost, type ModelPrice } from "./model-prices";

const apiErrorBodySchema = z.object({
  error: z.object({ type: z.string(), message: z.string() }),
});

/**
 * The API's own error type and message (e.g. a key without a workspace), safe to log: they
 * describe the request, never echo its content or the key.
 */
export function apiErrorDetail(error: { error: unknown }): {
  errorType?: string;
  errorMessage?: string;
} {
  const body = apiErrorBodySchema.safeParse(error.error);
  if (!body.success) return {};
  return { errorType: body.data.error.type, errorMessage: body.data.error.message.slice(0, 500) };
}

export interface TriageModel {
  /** Null when no valid answer came back (after one retry) or the API call failed. */
  classify(
    input: TriagePromptInput,
    record: (call: ModelCallInput) => Promise<void>,
  ): Promise<Classification | null>;
}

// Classification is short; this leaves room for the summary and file list.
const MAX_TOKENS = 1_024;
const ATTEMPTS = 2;

/** The answer, when the model finished normally and it's valid; null otherwise. */
function parseAnswer(response: Anthropic.Message): TriageOutput | null {
  if (response.stop_reason !== "end_turn") return null;
  const text = response.content.find((block) => block.type === "text")?.text;
  if (text === undefined) return null;
  try {
    const parsed = triageOutputSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function triageModel(options: {
  client: Anthropic;
  model: string;
  price: ModelPrice;
  logger: Logger;
}): TriageModel {
  const { client, model, price, logger } = options;
  // We validate the answer ourselves (parseAnswer) instead of messages.parse(), which throws on
  // an invalid answer and so loses its usage.
  const format = {
    type: "json_schema" as const,
    schema: TRIAGE_OUTPUT_JSON_SCHEMA,
  };
  const base = { purpose: "triage", model, promptVersion: TRIAGE_PROMPT_VERSION };

  return {
    async classify(input, record) {
      const { system, user } = buildTriagePrompt(input);
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        let response: Anthropic.Message;
        try {
          response = await client.messages.create({
            model,
            max_tokens: MAX_TOKENS,
            system,
            messages: [{ role: "user", content: user }],
            output_config: { format },
          });
        } catch (error) {
          if (!(error instanceof Anthropic.APIError)) throw error;
          // The SDK already retried what's retryable (429, 5xx, connection errors).
          await record({
            ...base,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0,
            outcome: "error",
          });
          logger.warn(
            { status: error.status, attempt, ...apiErrorDetail(error) },
            "triage model call failed",
          );
          return null;
        }
        const answer = parseAnswer(response);
        const { usage } = response;
        await record({
          ...base,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
          costUsd: callCost(price, usage),
          outcome: answer === null ? "invalid" : "valid",
        });
        if (answer !== null) return answer;
        logger.warn({ attempt, stopReason: response.stop_reason }, "invalid triage model answer");
      }
      return null;
    },
  };
}
