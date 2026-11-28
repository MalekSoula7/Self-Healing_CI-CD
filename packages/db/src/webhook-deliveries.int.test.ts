// Needs Postgres: `docker compose up -d` (runs against the `pipeheal_test` database).
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  installationDeliveryState,
  markWebhookDeliveryFailed,
  markWebhookDeliveryProcessed,
  recordWebhookDelivery,
} from "./webhook-deliveries";
import { createTestDb } from "./testing";

const db = createTestDb();

afterAll(async () => {
  await db.$disconnect();
});

function githubId(): bigint {
  return BigInt(randomInt(1, 2 ** 47));
}

describe("recordWebhookDelivery", () => {
  it("records a new delivery once", async () => {
    const deliveryId = randomUUID();

    const first = await recordWebhookDelivery(db, {
      deliveryId,
      event: "installation",
      action: "created",
      installationId: githubId(),
    });

    expect(first.isNew).toBe(true);
    const row = await db.webhookDelivery.findUniqueOrThrow({ where: { deliveryId } });
    expect(row).toMatchObject({ event: "installation", action: "created", processedAt: null });
  });

  it("is idempotent: a redelivered ID is recognized, not duplicated", async () => {
    const deliveryId = randomUUID();
    const first = await recordWebhookDelivery(db, { deliveryId, event: "ping" });

    const second = await recordWebhookDelivery(db, { deliveryId, event: "ping" });

    expect(second).toEqual({ id: first.id, isNew: false, processed: false });
    await expect(db.webhookDelivery.count({ where: { deliveryId } })).resolves.toBe(1);
  });

  it("tells a redelivery whether the first delivery was already processed", async () => {
    const deliveryId = randomUUID();
    await recordWebhookDelivery(db, { deliveryId, event: "installation" });
    await markWebhookDeliveryProcessed(db, deliveryId);

    await expect(
      recordWebhookDelivery(db, { deliveryId, event: "installation" }),
    ).resolves.toMatchObject({ isNew: false, processed: true });
  });

  it("is safe under a race: two concurrent calls agree on exactly one winner", async () => {
    const deliveryId = randomUUID();

    const [a, b] = await Promise.all([
      recordWebhookDelivery(db, { deliveryId, event: "installation_repositories" }),
      recordWebhookDelivery(db, { deliveryId, event: "installation_repositories" }),
    ]);

    expect([a.isNew, b.isNew].filter(Boolean)).toEqual([true]);
    await expect(db.webhookDelivery.count({ where: { deliveryId } })).resolves.toBe(1);
  });

  it("rejects a malformed delivery without writing a row", async () => {
    await expect(
      recordWebhookDelivery(db, { deliveryId: "", event: "installation" }),
    ).rejects.toThrow(ZodError);
  });
});

describe("markWebhookDeliveryProcessed / markWebhookDeliveryFailed", () => {
  it("records a failure, then clears it on success", async () => {
    const deliveryId = randomUUID();
    await recordWebhookDelivery(db, { deliveryId, event: "installation" });

    await markWebhookDeliveryFailed(db, deliveryId, "Organization not found");
    await expect(
      db.webhookDelivery.findUniqueOrThrow({ where: { deliveryId } }),
    ).resolves.toMatchObject({ error: "Organization not found", processedAt: null });

    await markWebhookDeliveryProcessed(db, deliveryId);
    await expect(
      db.webhookDelivery.findUniqueOrThrow({ where: { deliveryId } }),
    ).resolves.toMatchObject({ error: null });
    const { processedAt } = await db.webhookDelivery.findUniqueOrThrow({ where: { deliveryId } });
    expect(processedAt).toBeInstanceOf(Date);
  });

  it("truncates an oversized error rather than failing to record it", async () => {
    const deliveryId = randomUUID();
    await recordWebhookDelivery(db, { deliveryId, event: "installation" });

    await markWebhookDeliveryFailed(db, deliveryId, "x".repeat(5000));

    const { error } = await db.webhookDelivery.findUniqueOrThrow({ where: { deliveryId } });
    expect(error).toHaveLength(2000);
  });
});

describe("installationDeliveryState", () => {
  async function recordCreated(installationId: bigint): Promise<string> {
    const deliveryId = randomUUID();
    await recordWebhookDelivery(db, {
      deliveryId,
      event: "installation",
      action: "created",
      installationId,
    });
    return deliveryId;
  }

  it("follows a delivery from not received, to processing, to failed, to processed", async () => {
    const installationId = githubId();
    await expect(installationDeliveryState(db, installationId)).resolves.toBe("not-received");

    const deliveryId = await recordCreated(installationId);
    await expect(installationDeliveryState(db, installationId)).resolves.toBe("processing");

    await markWebhookDeliveryFailed(db, deliveryId, "GitHub answered 500");
    await expect(installationDeliveryState(db, installationId)).resolves.toBe("failed");

    await markWebhookDeliveryProcessed(db, deliveryId);
    await expect(installationDeliveryState(db, installationId)).resolves.toBe("processed");
  });

  it("only counts installation.created, for this installation, from the last hour", async () => {
    const installationId = githubId();
    await recordWebhookDelivery(db, {
      deliveryId: randomUUID(),
      event: "installation",
      action: "deleted",
      installationId,
    });
    await recordWebhookDelivery(db, {
      deliveryId: randomUUID(),
      event: "installation_repositories",
      action: "added",
      installationId,
    });
    await recordCreated(githubId());
    const old = await recordCreated(installationId);
    await db.webhookDelivery.update({
      where: { deliveryId: old },
      data: { receivedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });

    await expect(installationDeliveryState(db, installationId)).resolves.toBe("not-received");
  });

  it("rejects a malformed installation ID", async () => {
    await expect(installationDeliveryState(db, 0n)).rejects.toThrow(ZodError);
  });
});
