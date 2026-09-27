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
