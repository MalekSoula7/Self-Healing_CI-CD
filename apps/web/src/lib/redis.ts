import "server-only";
import { Redis } from "ioredis";
import { webEnv } from "@/env";
import { getLogger } from "./logger";

const cache = globalThis as { pipehealRedis?: Redis };

/** One ioredis connection per server process (BullMQ producer only; kept across hot reloads). */
export function getRedis(): Redis {
  cache.pipehealRedis ??= createRedis();
  return cache.pipehealRedis;
}

function createRedis(): Redis {
  const redis = new Redis(webEnv().REDIS_URL, { maxRetriesPerRequest: null });
  // Log the message only: the connection URL can carry a password.
  redis.on("error", (error: Error) => {
    getLogger().warn({ error: error.message }, "redis connection error");
  });
  return redis;
}
