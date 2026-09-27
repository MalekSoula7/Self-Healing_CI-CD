// Server-only: this module will hold secrets from Phase 1 on; importing it from a client component
// must fail the build rather than ship values to browsers.
import "server-only";
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

// Variables apps/web uses today. Later phases add theirs (auth, GitHub App, database).
export const webEnvSchema = z.object({
  NODE_ENV: nodeEnv,
  APP_URL: envHttpUrl.default("http://localhost:3000"),
});

// Production: no silent localhost defaults, and https unless the host is loopback (e2e).
const productionSchema = z.object({
  NODE_ENV: nodeEnv,
  APP_URL: envHttpUrl.refine(
    (url) => secureUnlessLoopback(url, "https:"),
    "must use https in production (loopback hosts excepted)",
  ),
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

let cached: WebEnv | undefined;

/** Validated server environment, parsed once. Throws on invalid configuration. */
export function webEnv(): WebEnv {
  cached ??= loadWebEnv();
  return cached;
}
