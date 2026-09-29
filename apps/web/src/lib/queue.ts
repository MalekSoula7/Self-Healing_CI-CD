import "server-only";
import { WEBHOOKS_QUEUE, type WebhookJobData } from "@pipeheal/shared";
import { Queue } from "bullmq";
import { getRedis } from "./redis";
import { getLogger } from "./logger";

const cache = globalThis as { pipehealWebhooksQueue?: Queue<WebhookJobData> };

function getWebhooksQueue(): Queue<WebhookJobData> {
  if (cache.pipehealWebhooksQueue === undefined) {
    const queue = new Queue<WebhookJobData>(WEBHOOKS_QUEUE, {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
    // Without a listener BullMQ prints connection errors (with stack) straight to stderr.
    queue.on("error", (error) => {
      getLogger().error({ error: error.message }, "webhooks queue error");
    });
    cache.pipehealWebhooksQueue = queue;
  }
  return cache.pipehealWebhooksQueue;
}

/**
 * Enqueues a webhook job for `apps/worker`. The job ID is the delivery ID, so a redelivery that
 * slips past the delivery-record check (a race) still can't be queued twice.
 */
export async function enqueueWebhookJob(data: WebhookJobData): Promise<void> {
  await getWebhooksQueue().add(data.event, data, { jobId: data.deliveryId });
}

export type RequeueOutcome = "retried" | "enqueued" | "unchanged";

/**
 * For a redelivery of a delivery the worker hasn't processed: retries its job with a fresh set
 * of attempts if it gave up, enqueues it again if the failed job was already pruned, and leaves a
 * job that is still waiting, delayed or running alone. A delivery we accepted never shows as
 * failed at GitHub, so without this neither GitHub's "Redeliver" nor SPEC §2.2's reconciler
 * could recover one the worker gave up on. Processors are idempotent, so a rerun is safe.
 */
export async function requeueJob(
  queue: Queue<WebhookJobData>,
  data: WebhookJobData,
): Promise<RequeueOutcome> {
  const job = await queue.getJob(data.deliveryId);
  if (job === undefined) {
    await queue.add(data.event, data, { jobId: data.deliveryId });
    return "enqueued";
  }
  if (await job.isFailed()) {
    await job.retry("failed", { resetAttemptsMade: true });
    return "retried";
  }
  return "unchanged";
}

export function requeueWebhookJob(data: WebhookJobData): Promise<RequeueOutcome> {
  return requeueJob(getWebhooksQueue(), data);
}
