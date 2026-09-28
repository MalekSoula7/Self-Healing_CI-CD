// GitHub webhook deliveries (SPEC §2, §12, §10). Not tenant-owned: a delivery is recorded before
// it can be attributed to an org (or may never be, e.g. a malformed payload), and its own ID is
// the only thing that needs protecting from replay. `apps/web` records deliveries at receipt,
// for idempotency; `apps/worker` marks them processed or failed once the queue job runs.
import type { Db } from "./client";
import {
  deliveryIdSchema,
  githubIdSchema,
  webhookDeliverySchema,
  type WebhookDeliveryInput,
} from "./inputs";

export interface RecordedDelivery {
  id: string;
  /** False when this delivery ID was already recorded: GitHub redelivered, or a retry raced us. */
  isNew: boolean;
  /** The worker already processed it successfully (always false for a new delivery). */
  processed: boolean;
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
    return { id: created.id, isNew: true, processed: false };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await db.webhookDelivery.findUniqueOrThrow({
      where: { deliveryId: data.deliveryId },
      select: { id: true, processedAt: true },
    });
    return { id: existing.id, isNew: false, processed: existing.processedAt !== null };
  }
}

/** Marks a delivery successfully processed, clearing any earlier failure. */
export async function markWebhookDeliveryProcessed(db: Db, deliveryId: string): Promise<void> {
  await db.webhookDelivery.update({
    where: { deliveryId: deliveryIdSchema.parse(deliveryId) },
    data: { processedAt: new Date(), error: null },
  });
}

/** Where the `installation.created` webhook for an installation is, as onboarding shows it. */
export type InstallationDeliveryState = "not-received" | "processing" | "failed" | "processed";

// The Setup URL redirect follows the install within seconds; looking back only this far keeps
// the query on the `receivedAt` index as workflow_run deliveries pile up.
const INSTALLATION_LOOKBACK_MS = 60 * 60 * 1000;

/**
 * The latest `installation.created` delivery for this installation, received in the last hour.
 * No error text: the caller shows this to a user who hasn't been tied to the installation yet.
 */
export async function installationDeliveryState(
  db: Db,
  installationId: bigint,
): Promise<InstallationDeliveryState> {
  const latest = await db.webhookDelivery.findFirst({
    where: {
      event: "installation",
      action: "created",
      installationId: githubIdSchema.parse(installationId),
      receivedAt: { gte: new Date(Date.now() - INSTALLATION_LOOKBACK_MS) },
    },
    orderBy: { receivedAt: "desc" },
    select: { processedAt: true, error: true },
  });
  if (latest === null) return "not-received";
  if (latest.processedAt !== null) return "processed";
  return latest.error === null ? "processing" : "failed";
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
