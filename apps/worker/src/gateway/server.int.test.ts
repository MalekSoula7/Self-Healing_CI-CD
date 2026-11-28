// Needs Redis: `docker compose up -d`. The gateway's rate limit against a real store, and against
// one that's down (P4.1b review H1: requests must fail fast, never hang, and /livez must not care).
import { createLogger } from "@pipeheal/shared/logger";
import { testRedisUrl } from "@pipeheal/shared/testing";
import type { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { createRateLimitRedis } from "../redis";
import { buildGateway } from "./server";

const logger = createLogger({ level: "silent", service: "test" });
const clients: Redis[] = [];

function limiterRedis(url: string): Redis {
  const redis = createRateLimitRedis(url, logger);
  clients.push(redis);
  return redis;
}

async function gateway(redis: Redis) {
  const app = await buildGateway({ logger, rateLimit: { max: 2, timeWindowMs: 60_000, redis } });
  app.get("/v1/probe", () => ({ ok: true }));
  return app;
}

/** A documentation-range address per test run, so runs within one window don't share buckets. */
function randomClient(): string {
  const group = () => Math.floor(Math.random() * 0xffff).toString(16);
  return `2001:db8:${group()}:${group()}::1`;
}

afterAll(() => {
  for (const redis of clients) redis.disconnect();
});

describe("gateway rate limit on Redis", () => {
  it("shares one budget across gateway instances", async () => {
    const redis = limiterRedis(testRedisUrl());
    await new Promise<void>((resolve) => {
      if (redis.status === "ready") resolve();
      else
        redis.once("ready", () => {
          resolve();
        });
    });
    const [a, b] = [await gateway(redis), await gateway(redis)];
    const client = randomClient();
    const hit = async (app: typeof a) =>
      (await app.inject({ method: "GET", url: "/v1/probe", remoteAddress: client })).statusCode;

    const statuses = [await hit(a), await hit(b), await hit(a)];
    await Promise.all([a.close(), b.close()]);

    expect(statuses).toEqual([200, 200, 429]);
  });

  it("fails requests fast when Redis is down, and /livez still answers", async () => {
    // Nothing listens on port 1: every limiter call errors at once (no offline queue).
    const app = await gateway(limiterRedis("redis://127.0.0.1:1"));
    const started = Date.now();
    const probe = await app.inject({ method: "GET", url: "/v1/probe" });
    const live = await app.inject({ method: "GET", url: "/livez" });
    await app.close();

    expect(probe.statusCode).toBe(500);
    expect(probe.json()).toEqual({ error: "internal error" });
    expect(live.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
