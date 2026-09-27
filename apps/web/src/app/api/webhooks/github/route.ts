// GitHub webhook receiver (SPEC §2 step 3, §12): verifies the signature, records the delivery
// for idempotency, enqueues a job for apps/worker, and answers fast. It never processes an event
// itself: long-running work stays in apps/worker (SPEC §4), and a slow response risks GitHub's
// ~10s webhook timeout.
import { recordWebhookDelivery } from "@pipeheal/db";
import { verifyWebhookSignature } from "@pipeheal/github";
import { webhookJobDataSchema } from "@pipeheal/shared";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { webEnv } from "@/env";
import { getDb } from "@/lib/db";
import { getLogger } from "@/lib/logger";
import { enqueueWebhookJob } from "@/lib/queue";

// A light peek at fields present on most event payloads, for delivery bookkeeping only. The
// worker validates the full, event-specific shape before acting on anything (CLAUDE.md).
const peekSchema = z.object({
  action: z.string().optional(),
  installation: z.object({ id: z.number().int().positive() }).optional(),
});

export async function POST(request: NextRequest): Promise<Response> {
  const logger = getLogger().child({ component: "webhooks" });
  const { GITHUB_WEBHOOK_SECRET: secret } = webEnv();
  if (secret === undefined) {
    logger.warn("webhook received but GITHUB_WEBHOOK_SECRET isn't configured");
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  // The exact bytes GitHub signed: read as text, never through request.json() (which would
  // re-serialize and could no longer match the signature).
  const rawBody = await request.text();
  if (!verifyWebhookSignature(secret, rawBody, request.headers.get("x-hub-signature-256"))) {
    logger.warn("webhook signature invalid");
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const deliveryId = request.headers.get("x-github-delivery");
  const event = request.headers.get("x-github-event");
  if (deliveryId === null || event === null) {
    return NextResponse.json({ error: "missing delivery headers" }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const peek = peekSchema.safeParse(payload).data;
  const action = peek?.action;
  const installationId =
    peek?.installation === undefined ? undefined : BigInt(peek.installation.id);

  const db = getDb();
  const { isNew } = await recordWebhookDelivery(db, { deliveryId, event, action, installationId });
  if (isNew) {
    await enqueueWebhookJob(webhookJobDataSchema.parse({ deliveryId, event, action, payload }));
    logger.info({ deliveryId, event, action }, "webhook enqueued");
  } else {
    // GitHub redelivery, or a retry that raced the first request: already handled (or in
    // progress). Never enqueue twice.
    logger.info({ deliveryId, event }, "webhook redelivery: already recorded");
  }

  return NextResponse.json({ received: true });
}
