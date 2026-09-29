// Model prices come from config (MODEL_PRICES), never code (SPEC §7.5): they change, and a model
// without a price must not be called.
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

/** USD per million tokens. Cache prices default to Anthropic's multipliers of the input price. */
export const modelPriceSchema = z.strictObject({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().optional(),
  cacheWrite: z.number().nonnegative().optional(),
});
export type ModelPrice = z.infer<typeof modelPriceSchema>;
export const modelPricesSchema = z.record(z.string().min(1), modelPriceSchema);
export type ModelPrices = z.infer<typeof modelPricesSchema>;

/** MODEL_PRICES: a JSON object of model id → ModelPrice. */
export const modelPricesJsonSchema = z
  .string()
  .transform((text, ctx): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      ctx.addIssue({ code: "custom", message: "must be a JSON object of model id → price" });
      return z.NEVER;
    }
  })
  .pipe(modelPricesSchema);

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/** What a response cost, in USD. */
export function callCost(price: ModelPrice, usage: Anthropic.Usage): number {
  const cacheRead = price.cacheRead ?? price.input * CACHE_READ_MULTIPLIER;
  const cacheWrite = price.cacheWrite ?? price.input * CACHE_WRITE_MULTIPLIER;
  return (
    (usage.input_tokens * price.input +
      usage.output_tokens * price.output +
      (usage.cache_read_input_tokens ?? 0) * cacheRead +
      (usage.cache_creation_input_tokens ?? 0) * cacheWrite) /
    1_000_000
  );
}
