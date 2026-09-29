// Server-only: this module holds secrets. Importing it from a client component must fail the
// build rather than ship values to browsers.
import "server-only";
// The light entry point: env is imported by instrumentation, which must not load Prisma.
import { DEV_DATABASE_URL, databaseUrlSchema, tlsUnlessLoopback } from "@pipeheal/db/url";
// The light entry point: webhookSecretSchema is a plain zod schema, no octokit import.
import { webhookSecretSchema } from "@pipeheal/github/credentials";
import {
  EnvValidationError,
  envHttpUrl,
  parseEnv,
  publicSecretNames,
  secureUnlessLoopback,
  type EnvSource,
} from "@pipeheal/shared";
import { z } from "zod";

const nodeEnv = z.enum(["development", "test", "production"]).default("development");
const logLevel = z.enum(["debug", "info", "warn", "error"]).default("info");
const authSecret = z.string().min(32, "must be at least 32 characters");
const nonEmpty = z.string().min(1);
const redisUrl = z.url({ protocol: /^rediss?$/, error: "must be a redis:// or rediss:// URL" });

// GitHub sign-in needs all three; in development they are optional together, so the app still
// runs before the GitHub App is registered (sign-in then says it isn't configured).
const SIGN_IN_KEYS = ["BETTER_AUTH_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"] as const;

export const webEnvSchema = z
  .object({
    NODE_ENV: nodeEnv,
    LOG_LEVEL: logLevel,
    APP_URL: envHttpUrl.default("http://localhost:3000"),
    DATABASE_URL: databaseUrlSchema.default(DEV_DATABASE_URL),
    REDIS_URL: redisUrl.default("redis://localhost:6379"),
    BETTER_AUTH_SECRET: authSecret.optional(),
    GITHUB_CLIENT_ID: nonEmpty.optional(),
    GITHUB_CLIENT_SECRET: nonEmpty.optional(),
    // Independent of sign-in: the webhook route (P1.6) works whether or not sign-in is
    // configured. Unset in development, it answers 503 instead of failing to start.
    GITHUB_WEBHOOK_SECRET: webhookSecretSchema.optional(),
    // The App's public page is github.com/apps/<slug>; the install link is built from it
    // (P1.7). Unset in development, /onboarding says installing isn't configured yet.
    GITHUB_APP_SLUG: nonEmpty.optional(),
  })
  .superRefine((env, ctx) => {
    const missing = SIGN_IN_KEYS.filter((key) => env[key] === undefined);
    if (missing.length === 0 || missing.length === SIGN_IN_KEYS.length) return;
    for (const key of missing) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `required when any of ${SIGN_IN_KEYS.join(", ")} is set`,
      });
    }
  });

// Production: no silent localhost defaults, sign-in configured, and https / TLS for every
// non-loopback host (loopback: e2e against a production build).
const productionSchema = z.object({
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
  APP_URL: envHttpUrl.refine(
    (url) => secureUnlessLoopback(url, "https:"),
    "must use https in production (loopback hosts excepted)",
  ),
  DATABASE_URL: databaseUrlSchema.refine(
    tlsUnlessLoopback,
    "must set sslmode=require (or verify-ca / verify-full) in production (loopback hosts excepted)",
  ),
  REDIS_URL: redisUrl.refine(
    (url) => secureUnlessLoopback(url, "rediss:"),
    "must use rediss:// in production (loopback hosts excepted)",
  ),
  BETTER_AUTH_SECRET: authSecret,
  GITHUB_CLIENT_ID: nonEmpty,
  GITHUB_CLIENT_SECRET: nonEmpty,
  GITHUB_WEBHOOK_SECRET: webhookSecretSchema,
  GITHUB_APP_SLUG: nonEmpty,
});

export type WebEnv = z.output<typeof webEnvSchema>;

export function loadWebEnv(source: EnvSource = process.env): WebEnv {
  const leaked = publicSecretNames(source);
  if (leaked.length > 0) {
    throw new EnvValidationError(
      leaked.map((key) => ({
        key,
        problem: "looks like a secret, and NEXT_PUBLIC_ variables are sent to browsers",
      })),
    );
  }
  return parseEnv(source.NODE_ENV === "production" ? productionSchema : webEnvSchema, source);
}

export interface GitHubSignInConfig {
  secret: string;
  clientId: string;
  clientSecret: string;
}

/** The GitHub sign-in settings, or null when sign-in isn't configured (development only). */
export function githubSignInConfig(env: WebEnv): GitHubSignInConfig | null {
  const { BETTER_AUTH_SECRET: secret, GITHUB_CLIENT_ID: clientId } = env;
  const clientSecret = env.GITHUB_CLIENT_SECRET;
  if (secret === undefined || clientId === undefined || clientSecret === undefined) return null;
  return { secret, clientId, clientSecret };
}

/** Where "Install GitHub App" sends the user, or null when GITHUB_APP_SLUG isn't set. */
export function githubAppInstallUrl(env: WebEnv): string | null {
  return env.GITHUB_APP_SLUG === undefined
    ? null
    : `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`;
}

let cached: WebEnv | undefined;

/** Validated server environment, parsed once. Throws on invalid configuration. */
export function webEnv(): WebEnv {
  cached ??= loadWebEnv();
  return cached;
}
