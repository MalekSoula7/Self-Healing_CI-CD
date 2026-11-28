// Compiling a custom rule with the self-hosted model (SPEC §8.7, P3.9). The model proposes; the
// caller validates the layer with packages/policy's schema, and an admin confirms it.
import {
  RULE_COMPILE_JSON_SCHEMA,
  buildRuleCompilerPrompt,
  ruleCompileOutputSchema,
  type RuleCompileOutput,
} from "@pipeheal/agent-core";
import type { Logger } from "@pipeheal/shared/logger";
import { OllamaError, type OllamaChatResponse, type OllamaClient } from "./ollama";

export interface RuleModel {
  /** The model's answer, or null when no valid one came back (after one retry). */
  compile(text: string): Promise<RuleCompileOutput | null>;
}

/** A rule and its answer are short. */
export const RULE_CONTEXT_TOKENS = 4_096;
const MAX_ANSWER_TOKENS = 512;
const ATTEMPTS = 2;

function parseAnswer(response: OllamaChatResponse): RuleCompileOutput | null {
  if (response.done_reason !== undefined && response.done_reason !== "stop") return null;
  try {
    const parsed = ruleCompileOutputSchema.safeParse(JSON.parse(response.message.content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function ruleModel(options: {
  client: OllamaClient;
  model: string;
  logger: Logger;
}): RuleModel {
  const { client, model, logger } = options;
  return {
    async compile(text) {
      const { system, user } = buildRuleCompilerPrompt(text);
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        let response: OllamaChatResponse;
        try {
          response = await client.chat({
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            format: RULE_COMPILE_JSON_SCHEMA,
            think: false,
            options: {
              num_ctx: RULE_CONTEXT_TOKENS,
              num_predict: MAX_ANSWER_TOKENS,
              temperature: 0,
            },
          });
        } catch (error) {
          if (!(error instanceof OllamaError)) throw error;
          logger.warn({ status: error.status, attempt, err: error }, "rule model call failed");
          return null;
        }
        const answer = parseAnswer(response);
        // Counts only: the rule and the answer stay out of the logs.
        logger.info(
          {
            attempt,
            inputTokens: response.prompt_eval_count ?? 0,
            outputTokens: response.eval_count ?? 0,
            valid: answer !== null,
          },
          "rule model answered",
        );
        if (answer !== null) return answer;
      }
      return null;
    },
  };
}
