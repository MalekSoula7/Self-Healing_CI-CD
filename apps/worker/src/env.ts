import { envPort, parseEnv, type EnvSource } from "@pipeheal/shared";
import { z } from "zod";

// Variables apps/worker uses today. Later phases add theirs.
export const workerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  REDIS_URL: z
    .url({ protocol: /^rediss?$/, error: "must be a redis:// or rediss:// URL" })
    .default("redis://localhost:6379"),
  GATEWAY_HOST: z.string().min(1).default("127.0.0.1"),
  GATEWAY_PORT: envPort.default(4000),
});

export type WorkerEnv = z.output<typeof workerEnvSchema>;

export function loadWorkerEnv(source?: EnvSource): WorkerEnv {
  return parseEnv(workerEnvSchema, source);
}
