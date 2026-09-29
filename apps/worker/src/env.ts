import { DEV_DATABASE_URL, databaseUrlSchema, tlsUnlessLoopback } from "@pipeheal/db/url";
import { githubAppIdSchema, githubPrivateKeySchema } from "@pipeheal/github/credentials";
import { envPort, parseEnv, secureUnlessLoopback, type EnvSource } from "@pipeheal/shared";
import { z } from "zod";
import { modelPricesJsonSchema, type ModelPrices } from "./model-prices";

const nodeEnv = z.enum(["development", "test", "production"]).default("development");
const redisUrl = z.url({ protocol: /^rediss?$/, error: "must be a redis:// or rediss:// URL" });

// Needed to sync repositories and workflows on install (P1.6). In development they are optional
// together, so the worker still runs before the GitHub App is registered: a webhook job that
// needs them then fails clearly (its own error, not a startup crash), same as web's sign-in.
const GITHUB_APP_KEYS = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"] as const;

// Triage (P2.4). Without ANTHROPIC_API_KEY (development only), jobs the heuristics can't classify
// stay `unknown`. With it, TRIAGE_MODEL must have a price: an unpriced call would go unrecorded.
const anthropic = {
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  TRIAGE_MODEL: z.string().min(1).default("claude-haiku-4-5-20251001"),
  MODEL_PRICES: modelPricesJsonSchema.optional(),
};

function checkTriageModel(
  env: { ANTHROPIC_API_KEY?: string; TRIAGE_MODEL: string; MODEL_PRICES?: ModelPrices },
  ctx: z.RefinementCtx,
): void {
  if (env.ANTHROPIC_API_KEY === undefined) return;
  if (env.MODEL_PRICES === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["MODEL_PRICES"],
      message: "required when ANTHROPIC_API_KEY is set",
    });
  } else if (!(env.TRIAGE_MODEL in env.MODEL_PRICES)) {
    ctx.addIssue({
      code: "custom",
      path: ["MODEL_PRICES"],
      message: "has no price for TRIAGE_MODEL",
    });
  }
}

// Variables apps/worker uses today. Later phases add theirs.
export const workerEnvSchema = z
  .object({
    NODE_ENV: nodeEnv,
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    REDIS_URL: redisUrl.default("redis://localhost:6379"),
    DATABASE_URL: databaseUrlSchema.default(DEV_DATABASE_URL),
    GATEWAY_HOST: z.string().min(1).default("127.0.0.1"),
    GATEWAY_PORT: envPort.default(4000),
    GITHUB_APP_ID: githubAppIdSchema.optional(),
    GITHUB_APP_PRIVATE_KEY: githubPrivateKeySchema.optional(),
    ...anthropic,
  })
  .superRefine((env, ctx) => {
    checkTriageModel(env, ctx);
    const missing = GITHUB_APP_KEYS.filter((key) => env[key] === undefined);
    if (missing.length === 0 || missing.length === GITHUB_APP_KEYS.length) return;
    for (const key of missing) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `required when ${GITHUB_APP_KEYS.join(", ")} is set`,
      });
    }
  });

// Production: no silent localhost defaults, GitHub App and triage model configured, and TLS unless
// the host is loopback.
const productionSchema = z
  .object({
    NODE_ENV: nodeEnv,
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    REDIS_URL: redisUrl.refine(
      (url) => secureUnlessLoopback(url, "rediss:"),
      "must use rediss:// in production (loopback hosts excepted)",
    ),
    DATABASE_URL: databaseUrlSchema.refine(
      tlsUnlessLoopback,
      "must set sslmode=require (or verify-ca / verify-full) in production (loopback hosts excepted)",
    ),
    GATEWAY_HOST: z.string().min(1).default("127.0.0.1"),
    GATEWAY_PORT: envPort.default(4000),
    GITHUB_APP_ID: githubAppIdSchema,
    GITHUB_APP_PRIVATE_KEY: githubPrivateKeySchema,
    ...anthropic,
    ANTHROPIC_API_KEY: z.string().min(1),
  })
  .superRefine(checkTriageModel);

export type WorkerEnv = z.output<typeof workerEnvSchema>;

export function loadWorkerEnv(source: EnvSource = process.env): WorkerEnv {
  return parseEnv(source.NODE_ENV === "production" ? productionSchema : workerEnvSchema, source);
}
