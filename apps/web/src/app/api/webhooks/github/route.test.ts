import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Mocks {
  webhookSecret: string | undefined;
  recordWebhookDelivery: ReturnType<typeof vi.fn>;
  enqueueWebhookJob: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted((): Mocks => ({
  webhookSecret: "w".repeat(32),
  recordWebhookDelivery: vi.fn(),
  enqueueWebhookJob: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock("@/env", () => ({ webEnv: () => ({ GITHUB_WEBHOOK_SECRET: mocks.webhookSecret }) }));
vi.mock("@/lib/db", () => ({ getDb: () => ({ fake: "db" }) }));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ child: () => ({ warn: mocks.warn, info: mocks.info }) }),
}));
vi.mock("@/lib/queue", () => ({ enqueueWebhookJob: mocks.enqueueWebhookJob }));
vi.mock("@pipeheal/db", () => ({ recordWebhookDelivery: mocks.recordWebhookDelivery }));

const { POST } = await import("./route");

const SECRET = "w".repeat(32);

function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function post(
  body: string,
  headers: Record<string, string> = {},
  options: { signWith?: string } = {},
) {
  const signWith = options.signWith ?? SECRET;
  return POST(
    new NextRequest("http://internal:3000/api/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
        "x-github-event": "installation",
        "x-hub-signature-256": sign(signWith, body),
        ...headers,
      },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.webhookSecret = SECRET;
  mocks.recordWebhookDelivery.mockResolvedValue({ id: "row-1", isNew: true });
  mocks.enqueueWebhookJob.mockResolvedValue(undefined);
});

describe("POST /api/webhooks/github", () => {
  it("verifies the signature, records the delivery, enqueues, and answers fast", async () => {
    const body = JSON.stringify({
      action: "created",
      installation: { id: 42 },
    });

    const response = await post(body);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    expect(mocks.recordWebhookDelivery).toHaveBeenCalledWith(
      { fake: "db" },
      {
        deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
        event: "installation",
        action: "created",
        installationId: 42n,
      },
    );
    expect(mocks.enqueueWebhookJob).toHaveBeenCalledWith({
      deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
      event: "installation",
      action: "created",
      payload: { action: "created", installation: { id: 42 } },
    });
  });

  it("rejects a bad signature without recording or enqueueing anything", async () => {
    const response = await post(JSON.stringify({ action: "created" }), {}, { signWith: "wrong" });

    expect(response.status).toBe(401);
    expect(mocks.recordWebhookDelivery).not.toHaveBeenCalled();
    expect(mocks.enqueueWebhookJob).not.toHaveBeenCalled();
  });

  it("rejects a missing signature header", async () => {
    const body = JSON.stringify({ action: "created" });
    const response = await POST(
      new NextRequest("http://internal:3000/api/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
          "x-github-event": "installation",
        },
      }),
    );

    expect(response.status).toBe(401);
    expect(mocks.recordWebhookDelivery).not.toHaveBeenCalled();
  });

  it("answers 503 without touching the signature, DB or queue when no secret is configured", async () => {
    mocks.webhookSecret = undefined;

    const response = await post(JSON.stringify({}));

    expect(response.status).toBe(503);
    expect(mocks.recordWebhookDelivery).not.toHaveBeenCalled();
    expect(mocks.enqueueWebhookJob).not.toHaveBeenCalled();
  });

  it("rejects a request missing x-github-delivery", async () => {
    const body = "{}";
    const request = new NextRequest("http://internal:3000/api/webhooks/github", {
      method: "POST",
      body,
      headers: { "x-github-event": "installation", "x-hub-signature-256": sign(SECRET, body) },
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(mocks.recordWebhookDelivery).not.toHaveBeenCalled();
  });

  it("rejects a request missing x-github-event", async () => {
    const body = "{}";
    const request = new NextRequest("http://internal:3000/api/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
        "x-hub-signature-256": sign(SECRET, body),
      },
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(mocks.recordWebhookDelivery).not.toHaveBeenCalled();
  });

  it("rejects a body that isn't valid JSON", async () => {
    const response = await post("not json");

    expect(response.status).toBe(400);
    expect(mocks.recordWebhookDelivery).not.toHaveBeenCalled();
  });

  it("acknowledges a redelivered delivery ID without enqueueing again", async () => {
    mocks.recordWebhookDelivery.mockResolvedValue({ id: "row-1", isNew: false });

    const response = await post(JSON.stringify({ action: "created" }));

    expect(response.status).toBe(200);
    expect(mocks.enqueueWebhookJob).not.toHaveBeenCalled();
  });

  it("handles a payload without an action or installation (e.g. ping)", async () => {
    const body = JSON.stringify({ zen: "Approachable is better than simple." });

    const response = await post(body, { "x-github-event": "ping" });

    expect(response.status).toBe(200);
    expect(mocks.recordWebhookDelivery).toHaveBeenCalledWith(
      { fake: "db" },
      {
        deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
        event: "ping",
        action: undefined,
        installationId: undefined,
      },
    );
  });

  it("verifies the exact bytes received, not a re-serialized body", async () => {
    // Unusual spacing that JSON.stringify would normalize away if the route re-serialized before
    // checking the signature.
    const body = '{"action":  "created", "installation": {"id": 1}}';

    const response = await post(body);

    expect(response.status).toBe(200);
  });
});
