// The BullMQ job `apps/web`'s webhook route enqueues and `apps/worker` consumes (SPEC §2 step 3,
// §4). Job data is JSON through Redis, so this carries the raw payload, not the zod-validated,
// BigInt-bearing shape each worker processor derives from it.
import { z } from "zod";

export const WEBHOOKS_QUEUE = "webhooks";

export const webhookJobDataSchema = z.object({
  /** X-GitHub-Delivery header; also the BullMQ job ID, so a redelivery can't double-enqueue. */
  deliveryId: z.string().min(1).max(100),
  /** X-GitHub-Event header. */
  event: z.string().min(1).max(100),
  /** The payload's own `action` field, when it has one (logged before the payload is parsed). */
  action: z.string().max(100).optional(),
  /** The verified webhook payload, exactly as GitHub sent it. Each processor validates its shape. */
  payload: z.unknown(),
});
export type WebhookJobData = z.infer<typeof webhookJobDataSchema>;
