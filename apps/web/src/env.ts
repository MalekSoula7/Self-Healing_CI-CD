import { envHttpUrl, parseEnv, type EnvSource } from "@pipeheal/shared";
import { z } from "zod";

// Variables apps/web uses today. Later phases add theirs (auth, GitHub App, database).
export const webEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: envHttpUrl.default("http://localhost:3000"),
});

export type WebEnv = z.output<typeof webEnvSchema>;

export function loadWebEnv(source?: EnvSource): WebEnv {
  return parseEnv(webEnvSchema, source);
}

let cached: WebEnv | undefined;

/** Validated server environment, parsed once. Throws on invalid configuration. */
export function webEnv(): WebEnv {
  cached ??= loadWebEnv();
  return cached;
}
