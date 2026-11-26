import { DEV_DATABASE_URL, databaseUrlSchema, tlsUnlessLoopback } from "@pipeheal/db/url";
import { githubAppIdSchema, githubPrivateKeySchema } from "@pipeheal/github/credentials";
import {
  envHttpUrl,
  envPort,
  parseEnv,
  secureUnlessLoopback,
  type EnvSource,
} from "@pipeheal/shared";
import { isIP } from "node:net";
import { z } from "zod";

const nodeEnv = z.enum(["development", "test", "production"]).default("development");
const redisUrl = z.url({ protocol: /^rediss?$/, error: "must be a redis:// or rediss:// URL" });

// Needed to sync repositories and workflows on install (P1.6). In development they are optional
// together, so the worker still runs before the GitHub App is registered: a webhook job that
// needs them then fails clearly (its own error, not a startup crash), same as web's sign-in.
const GITHUB_APP_KEYS = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"] as const;

// Triage (P2.4) runs on a self-hosted Ollama server (D11). In development it may be another machine
// on the LAN; in production it runs on the application's own host.
const OLLAMA_DEFAULT_URL = "http://localhost:11434";
// An Ollama model tag, e.g. "qwen3:14b" or "hf.co/org/model:Q4_K_M".
const modelTag = z.string().regex(/^[\w./:-]{1,100}$/, "must be an Ollama model tag");
const models = {
  TRIAGE_MODEL: modelTag.default("qwen3:14b"),
  // Healing, and compiling custom rules (SPEC §8.7).
  HEAL_MODEL: modelTag.default("qwen3:14b"),
};

/** An IP address or CIDR, as Fastify's `trustProxy` takes them. */
function isAddressOrCidr(value: string): boolean {
  const [address = "", prefix, ...rest] = value.split("/");
  const version = isIP(address);
  if (version === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (version === 4 ? 32 : 128);
}

// The agent gateway (P4.1b): a public listener for runners, an internal one for /readyz.
const gateway = {
  GATEWAY_HOST: z.string().min(1).default("127.0.0.1"),
  GATEWAY_PORT: envPort.default(4000),
  // Internal listener for /readyz (dependency states); keep it off the public network.
  GATEWAY_INTERNAL_HOST: z.string().min(1).default("127.0.0.1"),
  GATEWAY_INTERNAL_PORT: envPort.default(4001),
  // Comma-separated addresses or CIDRs of reverse proxies in front of the gateway, whose
  // X-Forwarded-For is believed for rate limiting. Empty: no proxy is trusted.
  GATEWAY_TRUSTED_PROXIES: z
    .string()
    .default("")
    .transform((list) =>
      list
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ""),
    )
    .pipe(z.array(z.string().refine(isAddressOrCidr, "must be IP addresses or CIDRs")).max(32)),
};

function separateGatewayPorts(
  env: { GATEWAY_PORT: number; GATEWAY_INTERNAL_PORT: number },
  ctx: z.RefinementCtx,
): void {
  if (env.GATEWAY_PORT !== env.GATEWAY_INTERNAL_PORT) return;
  ctx.addIssue({
    code: "custom",
    path: ["GATEWAY_INTERNAL_PORT"],
    message: "must differ from GATEWAY_PORT (readiness is never served to runners)",
  });
}

// The App's slug: its runs' OIDC `actor` is `<slug>[bot]` (SPEC §5.4), checked at session exchange.
const githubAppSlug = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{0,99}$/i, "must be a GitHub App slug (the name in its URL)");

// Variables apps/worker uses today. Later phases add theirs.
export const workerEnvSchema = z
  .object({
    NODE_ENV: nodeEnv,
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    REDIS_URL: redisUrl.default("redis://localhost:6379"),
    DATABASE_URL: databaseUrlSchema.default(DEV_DATABASE_URL),
    ...gateway,
    GITHUB_APP_ID: githubAppIdSchema.optional(),
    GITHUB_APP_PRIVATE_KEY: githubPrivateKeySchema.optional(),
    // Without it the gateway refuses every session exchange.
    GITHUB_APP_SLUG: githubAppSlug.optional(),
    OLLAMA_URL: envHttpUrl.default(OLLAMA_DEFAULT_URL),
    ...models,
  })
  .superRefine((env, ctx) => {
    separateGatewayPorts(env, ctx);
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
    ...gateway,
    GITHUB_APP_ID: githubAppIdSchema,
    GITHUB_APP_PRIVATE_KEY: githubPrivateKeySchema,
    GITHUB_APP_SLUG: githubAppSlug,
    // Set explicitly; https unless the model runs on this host (its usual place).
    OLLAMA_URL: envHttpUrl.refine(
      (url) => secureUnlessLoopback(url, "https:"),
      "must use https in production (loopback hosts excepted)",
    ),
    ...models,
  })
  .superRefine(separateGatewayPorts);

export type WorkerEnv = z.output<typeof workerEnvSchema>;

export function loadWorkerEnv(source: EnvSource = process.env): WorkerEnv {
  return parseEnv(source.NODE_ENV === "production" ? productionSchema : workerEnvSchema, source);
}
