// GitHub webhook deliveries (SPEC §2, §12, §10). Not tenant-owned: a delivery is recorded before
// it can be attributed to an org (or may never be, e.g. a malformed payload), and its own ID is
// the only thing that needs protecting from replay. `apps/web` records deliveries at receipt,
// for idempotency; `apps/worker` marks them processed or failed once the queue job runs.
import type { Db } from "./client";
import { deliveryIdSchema, webhookDeliverySchema, type WebhookDeliveryInput } from "./inputs";

export interface RecordedDelivery {
  id: string;
  /** False when this delivery ID was already recorded: GitHub redelivered, or a retry raced us. */
  isNew: boolean;
}

// Postgres unique_violation.
const UNIQUE_VIOLATION = "P2002";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === UNIQUE_VIOLATION
  );
}

/**
 * Records a delivery by its GitHub delivery ID. Safe to call more than once for the same ID
 * (redeliveries, or two racing requests): only the first call returns `isNew: true`.
 */
export async function recordWebhookDelivery(
  db: Db,
  input: WebhookDeliveryInput,
): Promise<RecordedDelivery> {
  const data = webhookDeliverySchema.parse(input);
  try {
    const created = await db.webhookDelivery.create({ data });
    return { id: created.id, isNew: true };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await db.webhookDelivery.findUniqueOrThrow({
      where: { deliveryId: data.deliveryId },
      select: { id: true },
    });
    return { id: existing.id, isNew: false };
  }
}

/** Marks a delivery successfully processed, clearing any earlier failure. */
export async function markWebhookDeliveryProcessed(db: Db, deliveryId: string): Promise<void> {
  await db.webhookDelivery.update({
    where: { deliveryId: deliveryIdSchema.parse(deliveryId) },
    data: { processedAt: new Date(), error: null },
  });
}

/** Records the latest processing failure. `error` must already be redacted (CLAUDE.md). */
export async function markWebhookDeliveryFailed(
  db: Db,
  deliveryId: string,
  error: string,
): Promise<void> {
  await db.webhookDelivery.update({
    where: { deliveryId: deliveryIdSchema.parse(deliveryId) },
    data: { error: error.slice(0, 2000) },
  });
}
