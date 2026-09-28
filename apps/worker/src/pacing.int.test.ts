// Needs Redis and Postgres: `docker compose up -d`. Real BullMQ, on unique key prefixes.
import { randomInt, randomUUID } from "node:crypto";
import { recordWebhookDelivery } from "@pipeheal/db";
import { createTestDb } from "@pipeheal/db/testing";
import { createLogger } from "@pipeheal/shared/logger";
import { testRedisUrl } from "@pipeheal/shared/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RATE_LIMIT_RESERVE, redisPacing, type InstallationPacing } from "./pacing";
import { createWebhooksQueue, createWebhooksWorker, type WebhooksQueue } from "./queues/webhooks";

const logger = createLogger({ level: "silent", service: "test" });
const db = createTestDb();
let redis: Redis;
let pacing: InstallationPacing;
const keyPrefix = `test-ratelimit-${randomUUID()}:`;

beforeAll(() => {
  redis = new Redis(testRedisUrl(), { maxRetriesPerRequest: null });
  pacing = redisPacing(redis, logger, keyPrefix);
});

afterAll(async () => {
  const keys = await redis.keys(`${keyPrefix}*`);
  if (keys.length > 0) await redis.del(...keys);
  redis.disconnect();
  await db.$disconnect();
});

function installationId(): bigint {
  return BigInt(randomInt(1, 2 ** 47));
}

async function until(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("redisPacing", () => {
  const inAnHour = () => new Date(Date.now() + 3_600_000);

  it("lets an installation run while it has quota to spare", async () => {
    const id = installationId();
    await expect(pacing.pausedUntil(id)).resolves.toBeNull();

    pacing.record(id, { remaining: RATE_LIMIT_RESERVE + 1, resetAt: inAnHour() });

    await until(async () => (await redis.exists(`${keyPrefix}${String(id)}`)) === 1);
    await expect(pacing.pausedUntil(id)).resolves.toBeNull();
  });

  it("makes an installation wait for its reset once its quota runs low", async () => {
    const id = installationId();
    const resetAt = inAnHour();

    pacing.record(id, { remaining: RATE_LIMIT_RESERVE - 1, resetAt });

    await until(async () => (await pacing.pausedUntil(id)) !== null);
    await expect(pacing.pausedUntil(id)).resolves.toEqual(resetAt);
  });

  it("pauses one installation without touching another", async () => {
    const [limited, other] = [installationId(), installationId()];
    const resumeAt = new Date(Date.now() + 60_000);

    await pacing.pause(limited, resumeAt);

    await expect(pacing.pausedUntil(limited)).resolves.toEqual(resumeAt);
    await expect(pacing.pausedUntil(other)).resolves.toBeNull();
  });

  it("forgets a pause once its time has passed", async () => {
    const id = installationId();

    await pacing.pause(id, new Date(Date.now() + 1_200));

    await expect(pacing.pausedUntil(id)).resolves.not.toBeNull();
    await until(async () => (await pacing.pausedUntil(id)) === null);
  });

  it("treats an unreadable record as no record", async () => {
    const id = installationId();
    await redis.set(`${keyPrefix}${String(id)}`, "{not json", "PX", 60_000);

    await expect(pacing.pausedUntil(id)).resolves.toBeNull();
  });
});

describe("webhooks worker with a rate-limited installation", () => {
  const prefix = `test-${randomUUID()}`;
  let queue: WebhooksQueue;

  beforeAll(() => {
    queue = createWebhooksQueue(redis, logger, prefix);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
  });

  it("delays that installation's jobs until the reset, without failing them, and runs others", async () => {
    const [limited, other] = [installationId(), installationId()];
    const resumeAt = new Date(Date.now() + 10 * 60_000);
    await pacing.pause(limited, resumeAt);
    const worker = createWebhooksWorker(
      redis.duplicate(),
      {
        db,
        githubApp: null,
        logger,
        failureJobs: {
          scheduleWindowClose: () => Promise.resolve(),
          enqueueTriage: () => Promise.resolve(),
        },
        pacing,
      },
      prefix,
    );
    const job = (id: bigint) => {
      const deliveryId = randomUUID();
      return {
        deliveryId,
        data: {
          deliveryId,
          event: "pull_request",
          action: "opened",
          payload: { installation: { id: Number(id) } },
        },
      };
    };
    const [paused, running] = [job(limited), job(other)];
    for (const { deliveryId } of [paused, running]) {
      await recordWebhookDelivery(db, { deliveryId, event: "pull_request", action: "opened" });
    }

    try {
      await queue.add("pull_request", paused.data, { jobId: paused.deliveryId });
      await queue.add("pull_request", running.data, { jobId: running.deliveryId });

      await until(
        async () => (await (await queue.getJob(running.deliveryId))?.getState()) === "completed",
      );
      await until(
        async () => (await (await queue.getJob(paused.deliveryId))?.getState()) === "delayed",
      );
    } finally {
      await worker.close();
    }

    const delayed = await queue.getJob(paused.deliveryId);
    expect(delayed?.attemptsMade).toBe(0);
    expect((delayed?.timestamp ?? 0) + (delayed?.delay ?? 0)).toBeGreaterThanOrEqual(
      resumeAt.getTime() - 1_000,
    );
    await expect(
      db.webhookDelivery.findUniqueOrThrow({ where: { deliveryId: paused.deliveryId } }),
    ).resolves.toMatchObject({ processedAt: null, error: null });
    await expect(
      db.webhookDelivery.findUniqueOrThrow({ where: { deliveryId: running.deliveryId } }),
    ).resolves.toMatchObject({ processedAt: expect.any(Date) as Date });
  });
});
