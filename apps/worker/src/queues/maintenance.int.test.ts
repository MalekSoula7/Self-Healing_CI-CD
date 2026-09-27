// Needs Redis: `docker compose up -d` (REDIS_URL, default redis://localhost:6379).
import { randomUUID } from "node:crypto";
import { QueueEvents, type Worker } from "bullmq";
import type { Redis } from "ioredis";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildGateway } from "../gateway/server";
import { createRedis, pingRedis } from "../redis";
import {
  MAINTENANCE_QUEUE,
  createMaintenanceQueue,
  createMaintenanceWorker,
  type MaintenanceQueue,
} from "./maintenance";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const logger = pino({ level: "silent" });

function ready<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("test setup did not complete");
  return value;
}

async function waitUntilReady(redis: Redis, timeoutMs: number): Promise<void> {
  if (redis.status === "ready") return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Host only: the URL can carry a password.
      const { host } = new URL(REDIS_URL);
      reject(new Error(`Redis not reachable at ${host}. Run \`docker compose up -d\`.`));
    }, timeoutMs);
    redis.once("ready", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe("maintenance queue against real Redis", () => {
  const prefix = `test-${randomUUID()}`;
  let redis: Redis;
  let eventsConnection: Redis | undefined;
  let queue: MaintenanceQueue | undefined;
  let worker: Worker | undefined;
  let events: QueueEvents | undefined;

  beforeAll(async () => {
    redis = createRedis(REDIS_URL, logger);
    await waitUntilReady(redis, 5000);
    eventsConnection = redis.duplicate();
    queue = createMaintenanceQueue(redis, logger, prefix);
    worker = createMaintenanceWorker(redis, logger, prefix);
    events = new QueueEvents(MAINTENANCE_QUEUE, { connection: eventsConnection, prefix });
    await Promise.all([worker.waitUntilReady(), events.waitUntilReady()]);
  });

  // Tolerates a failed beforeAll, so the only error shown is the "Redis not reachable" one.
  afterAll(async () => {
    await worker?.close();
    await events?.close();
    if (redis.status === "ready") await queue?.obliterate({ force: true });
    await queue?.close();
    await eventsConnection?.quit();
    redis.disconnect();
  });

  it("processes a ping end to end", async () => {
    const requestedAt = new Date().toISOString();
    const job = await ready(queue).add("ping", { requestedAt });
    const result = await job.waitUntilFinished(ready(events), 5000);
    expect(result).toEqual({ pong: true, requestedAt });
  });

  it("fails a ping with invalid data", async () => {
    const job = await ready(queue).add("ping", { requestedAt: "not-a-date" }, { attempts: 1 });
    await expect(job.waitUntilFinished(ready(events), 5000)).rejects.toThrow();
  });

  it("reports Redis as up through the gateway health check", async () => {
    expect(await pingRedis(redis)).toBe(true);
    const gateway = buildGateway({ logger, checks: { redis: () => pingRedis(redis) } });
    const response = await gateway.inject({ method: "GET", url: "/health" });
    await gateway.close();
    expect(response.statusCode).toBe(200);
  });
});
