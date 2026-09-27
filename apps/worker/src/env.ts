import { envPort, parseEnv, secureUnlessLoopback, type EnvSource } from "@pipeheal/shared";
import { z } from "zod";

const nodeEnv = z.enum(["development", "test", "production"]).default("development");
const redisUrl = z.url({ protocol: /^rediss?$/, error: "must be a redis:// or rediss:// URL" });

// Variables apps/worker uses today. Later phases add theirs.
export const workerEnvSchema = z.object({
  NODE_ENV: nodeEnv,
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  REDIS_URL: redisUrl.default("redis://localhost:6379"),
  GATEWAY_HOST: z.string().min(1).default("127.0.0.1"),
  GATEWAY_PORT: envPort.default(4000),
});

// Production: no silent localhost default, and TLS unless the host is loopback.
const productionSchema = workerEnvSchema.extend({
  REDIS_URL: redisUrl.refine(
    (url) => secureUnlessLoopback(url, "rediss:"),
    "must use rediss:// in production (loopback hosts excepted)",
  ),
});

export type WorkerEnv = z.output<typeof workerEnvSchema>;

export function loadWorkerEnv(source: EnvSource = process.env): WorkerEnv {
  return parseEnv(source.NODE_ENV === "production" ? productionSchema : workerEnvSchema, source);
}
