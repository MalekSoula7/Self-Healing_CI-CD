// Needs Postgres: `docker compose up -d`. Redelivering failed webhooks (SPEC §2.2, P5.3c) with the
// real delivery records and GitHub on msw.
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  markWebhookDeliveryFailed,
  markWebhookDeliveryProcessed,
  recordWebhookDelivery,
} from "@pipeheal/db";
import { createTestDb } from "@pipeheal/db/testing";
import { createGitHubApp } from "@pipeheal/github";
import { createLogger } from "@pipeheal/shared/logger";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MAX_PER_SWEEP, redeliverFailed, type RedeliverDeps } from "./redeliver";

const db = createTestDb();
const github = setupServer();
const logger = createLogger({ level: "silent", service: "test" });
const URL_ = "https://api.github.com/app/hook/deliveries";
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

beforeAll(() => {
  github.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  github.resetHandlers();
});
afterAll(async () => {
  github.close();
  await db.$disconnect();
});

const deps = (): RedeliverDeps => ({
  db,
  githubApp: createGitHubApp({ appId: 1234, privateKey, retries: 0 }),
  logger,
});

interface Sent {
  id: number;
  guid: string;
  minutesAgo: number;
  status: number;
  event?: string;
  /** False for GitHub's first attempt at an event. */
  redelivery?: boolean;
}

/** GitHub's delivery list (newest first) and its redelivery endpoint. */
function mockDeliveries(sent: Sent[], refuse: number[] = []) {
  const redelivered: number[] = [];
  const newest = [...sent].sort((a, b) => a.minutesAgo - b.minutesAgo);
  github.use(
    http.get(URL_, () =>
      HttpResponse.json(
        newest.map((delivery) => ({
          id: delivery.id,
          guid: delivery.guid,
          delivered_at: new Date(Date.now() - delivery.minutesAgo * 60_000).toISOString(),
          status_code: delivery.status,
          event: delivery.event ?? "workflow_run",
          redelivery: delivery.redelivery ?? false,
        })),
      ),
    ),
    http.post(`${URL_}/:id/attempts`, ({ params }) => {
      const id = Number(params.id);
      if (refuse.includes(id)) return HttpResponse.json({ message: "no" }, { status: 422 });
      redelivered.push(id);
      return HttpResponse.json({}, { status: 202 });
    }),
  );
  return redelivered;
}

/** A delivery we accepted: processed, failed, or still in progress. */
async function received(state: "processed" | "failed" | "in progress") {
  const guid = randomUUID();
  await recordWebhookDelivery(db, { deliveryId: guid, event: "workflow_run" });
  if (state === "failed") await markWebhookDeliveryFailed(db, guid, "boom");
  if (state === "processed") await markWebhookDeliveryProcessed(db, guid);
  return guid;
}

describe("redeliverFailed", () => {
  it("asks again for what never got a 2xx, oldest first", async () => {
    const redelivered = mockDeliveries([
      { id: 1, guid: randomUUID(), minutesAgo: 15, status: 502 },
      { id: 2, guid: randomUUID(), minutesAgo: 60, status: 0 },
    ]);

    await expect(redeliverFailed(deps())).resolves.toBe(2);

    expect(redelivered).toEqual([2, 1]);
  });

  it("asks again for an accepted delivery the worker gave up on, and no other", async () => {
    const failed = await received("failed");
    const redelivered = mockDeliveries([
      { id: 1, guid: failed, minutesAgo: 20, status: 202 },
      { id: 2, guid: await received("processed"), minutesAgo: 20, status: 202 },
      { id: 3, guid: await received("in progress"), minutesAgo: 20, status: 202 },
      // Delivered, and unknown to us (another environment's): left alone.
      { id: 4, guid: randomUUID(), minutesAgo: 20, status: 202 },
    ]);

    await redeliverFailed(deps());

    expect(redelivered).toEqual([1]);
  });

  it("waits longer after each attempt, and stops after the fifth", async () => {
    const [young, early, due, spent] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const attempts = (guid: string, first: number, count: number, latest: number): Sent[] =>
      Array.from({ length: count }, (_, index) => ({
        id: first + index,
        guid,
        // `first` is the latest attempt.
        minutesAgo: latest + index * 5,
        status: 502,
        redelivery: index < count - 1,
      }));
    const redelivered = mockDeliveries([
      ...attempts(young, 10, 1, 5),
      ...attempts(early, 20, 2, 20),
      ...attempts(due, 30, 2, 31),
      ...attempts(spent, 40, 5, 600),
    ]);

    await redeliverFailed(deps());

    expect(redelivered).toEqual([30]);
  });

  it("never replays installation events: their order matters", async () => {
    const redelivered = mockDeliveries(
      ["installation", "installation_repositories", "pull_request"].map((event, index) => ({
        id: index + 1,
        guid: randomUUID(),
        minutesAgo: 60,
        status: 502,
        event,
      })),
    );

    await expect(redeliverFailed(deps())).resolves.toBe(0);
    expect(redelivered).toEqual([]);
  });

  it("stops once the first attempt is out of view, so the cap holds", async () => {
    const redelivered = mockDeliveries([
      { id: 1, guid: randomUUID(), minutesAgo: 600, status: 502, redelivery: true },
    ]);

    await redeliverFailed(deps());

    expect(redelivered).toEqual([]);
  });

  it("caps one sweep and carries on past a refused redelivery", async () => {
    const sent = Array.from({ length: MAX_PER_SWEEP + 5 }, (_, index) => ({
      id: index + 1,
      guid: randomUUID(),
      minutesAgo: 1_000 - index,
      status: 502,
    }));
    const redelivered = mockDeliveries(sent, [1]);

    await expect(redeliverFailed(deps())).resolves.toBe(MAX_PER_SWEEP - 1);

    expect(redelivered[0]).toBe(2);
  });

  it("does nothing without a GitHub App", async () => {
    await expect(redeliverFailed({ ...deps(), githubApp: null })).resolves.toBe(0);
  });
});
