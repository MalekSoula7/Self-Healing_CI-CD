import { Redis } from "ioredis";
import type { Logger } from "@pipeheal/shared/logger";

export function createRedis(url: string, logger: Logger): Redis {
  // BullMQ workers need maxRetriesPerRequest: null (blocking commands must not time out).
  const redis = new Redis(url, { maxRetriesPerRequest: null });
  // Log the message only: the connection URL can carry a password.
  redis.on("error", (error: Error) => {
    logger.warn({ error: error.message }, "redis connection error");
  });
  return redis;
}

/** True when Redis answers PING within `timeoutMs`. Never throws, never hangs. */
export async function pingRedis(redis: Redis, timeoutMs = 1000): Promise<boolean> {
  if (redis.status !== "ready") return false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
  });
  try {
    return await Promise.race([redis.ping().then(() => true), timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
