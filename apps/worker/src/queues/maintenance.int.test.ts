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

async function waitUntilReady(redis: Redis, timeoutMs: number): Promise<void> {
  if (redis.status === "ready") return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Redis not reachable at ${REDIS_URL}. Run \`docker compose up -d\`.`));
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
  let eventsConnection: Redis;
  let queue: MaintenanceQueue;
  let worker: Worker;
  let events: QueueEvents;

  beforeAll(async () => {
    redis = createRedis(REDIS_URL, logger);
    await waitUntilReady(redis, 5000);
    eventsConnection = redis.duplicate();
    queue = createMaintenanceQueue(redis, logger, prefix);
    worker = createMaintenanceWorker(redis, logger, prefix);
    events = new QueueEvents(MAINTENANCE_QUEUE, { connection: eventsConnection, prefix });
    await Promise.all([worker.waitUntilReady(), events.waitUntilReady()]);
  });

  afterAll(async () => {
    await worker.close();
    await events.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await eventsConnection.quit();
    await redis.quit();
  });

  it("processes a ping end to end", async () => {
    const requestedAt = new Date().toISOString();
    const job = await queue.add("ping", { requestedAt });
    const result = await job.waitUntilFinished(events, 5000);
    expect(result).toEqual({ pong: true, requestedAt });
  });

  it("fails a ping with invalid data", async () => {
    const job = await queue.add("ping", { requestedAt: "not-a-date" }, { attempts: 1 });
    await expect(job.waitUntilFinished(events, 5000)).rejects.toThrow();
  });

  it("reports Redis as up through the gateway health check", async () => {
    expect(await pingRedis(redis)).toBe(true);
    const gateway = buildGateway({ logger, checks: { redis: () => pingRedis(redis) } });
    const response = await gateway.inject({ method: "GET", url: "/health" });
    await gateway.close();
    expect(response.statusCode).toBe(200);
  });
});
