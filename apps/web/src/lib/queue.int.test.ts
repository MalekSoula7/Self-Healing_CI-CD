// Needs Redis: `docker compose up -d`. Real BullMQ, on a unique key prefix per run.
import { randomUUID } from "node:crypto";
import { WEBHOOKS_QUEUE, type WebhookJobData } from "@pipeheal/shared";
import { testRedisUrl } from "@pipeheal/shared/testing";
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requeueJob } from "./queue";

const prefix = `test-${randomUUID()}`;
let connection: Redis;
let queue: Queue<WebhookJobData>;

beforeAll(() => {
  connection = new Redis(testRedisUrl(), { maxRetriesPerRequest: null });
  queue = new Queue<WebhookJobData>(WEBHOOKS_QUEUE, { connection, prefix });
});

afterAll(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
  connection.disconnect();
});

function jobData(): WebhookJobData {
  return {
    deliveryId: randomUUID(),
    event: "installation_repositories",
    action: "added",
    payload: { action: "added" },
  };
}

async function stateOf(deliveryId: string): Promise<string | undefined> {
  return (await queue.getJob(deliveryId))?.getState();
}

/** Runs one real attempt that throws, so the job ends in BullMQ's failed set. */
async function failOnce(data: WebhookJobData): Promise<void> {
  await queue.add(data.event, data, { jobId: data.deliveryId, attempts: 1 });
  const worker = new Worker<WebhookJobData>(
    WEBHOOKS_QUEUE,
    () => Promise.reject(new Error("GitHub answered 409")),
    { connection: connection.duplicate(), prefix },
  );
  await new Promise<void>((resolve) => {
    worker.on("failed", (job?: Job<WebhookJobData>) => {
      if (job?.id === data.deliveryId) resolve();
    });
  });
  await worker.close();
}

describe("requeueJob", () => {
  it("retries a job the worker gave up on, with a fresh set of attempts", async () => {
    const data = jobData();
    await failOnce(data);
    expect(await stateOf(data.deliveryId)).toBe("failed");

    await expect(requeueJob(queue, data)).resolves.toBe("retried");

    const job = await queue.getJob(data.deliveryId);
    expect(await job?.getState()).toBe("waiting");
    expect(job?.attemptsMade).toBe(0);
  });

  it("enqueues it again when the failed job was already pruned", async () => {
    const data = jobData();

    await expect(requeueJob(queue, data)).resolves.toBe("enqueued");

    const job = await queue.getJob(data.deliveryId);
    expect(job?.data).toEqual(data);
    expect(await job?.getState()).toBe("waiting");
  });

  it("leaves a job that is still queued alone, and never queues it twice", async () => {
    const data = jobData();
    await queue.add(data.event, data, { jobId: data.deliveryId });

    await expect(requeueJob(queue, data)).resolves.toBe("unchanged");

    expect(await stateOf(data.deliveryId)).toBe("waiting");
    const waiting = await queue.getJobs(["waiting", "delayed", "failed"]);
    expect(waiting.filter((job) => job.id === data.deliveryId)).toHaveLength(1);
  });
});
