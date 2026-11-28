import { mockServer } from "@pipeheal/shared/testing";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TARGET,
  forwardDelivery,
  parseSseEvents,
  relay,
  relayEnvSchema,
  type RelayedDelivery,
} from "./smee-relay";

const CHANNEL = "https://smee.io/aBcDeF123";

function smeeMessage(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    host: "smee.io",
    "x-github-event": "installation",
    "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    "x-hub-signature-256": `sha256=${"a".repeat(64)}`,
    "x-github-hook-id": "123",
    cookie: "should-not-be-forwarded",
    body: { action: "created", installation: { id: 42 } },
    query: {},
    timestamp: 1,
    ...overrides,
  });
}

function captureTarget() {
  const received: { headers: Record<string, string>; body: string }[] = [];
  mockServer.use(
    http.post(DEFAULT_TARGET, async ({ request }) => {
      received.push({ headers: Object.fromEntries(request.headers), body: await request.text() });
      return new HttpResponse(null, { status: 202 });
    }),
  );
  return received;
}

describe("parseSseEvents", () => {
  it("splits complete events and keeps the unfinished rest", () => {
    const { events, rest } = parseSseEvents(
      'event: ready\ndata: {}\n\ndata: {"a":1}\r\n\r\n: comment\n\nevent: ping\ndata: x\n\ndata: partial',
    );

    expect(events).toEqual([
      { event: "ready", data: "{}" },
      { event: "message", data: '{"a":1}' },
      { event: "ping", data: "x" },
    ]);
    expect(rest).toBe("data: partial");
  });

  it("joins multi-line data", () => {
    expect(parseSseEvents("data: a\ndata: b\n\n").events).toEqual([
      { event: "message", data: "a\nb" },
    ]);
  });
});

describe("forwardDelivery", () => {
  it("forwards the body with GitHub's headers only", async () => {
    const received = captureTarget();

    const result = await forwardDelivery(smeeMessage(), DEFAULT_TARGET);

    expect(result).toEqual({
      event: "installation",
      deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
      status: 202,
    });
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]?.body ?? "")).toEqual({
      action: "created",
      installation: { id: 42 },
    });
    expect(received[0]?.headers).toMatchObject({
      "content-type": "application/json",
      "x-github-event": "installation",
      "x-hub-signature-256": `sha256=${"a".repeat(64)}`,
      "x-github-hook-id": "123",
    });
    expect(received[0]?.headers).not.toHaveProperty("cookie");
    expect(received[0]?.headers).not.toHaveProperty("host", "smee.io");
  });

  it("prefers the exact signed bytes when smee.io provides them", async () => {
    const received = captureTarget();
    const rawBody = '{"action":"created",  "note":"caf\\u00e9"}';

    await forwardDelivery(smeeMessage({ rawBody }), DEFAULT_TARGET);

    expect(received[0]?.body).toBe(rawBody);
  });

  it.each(["not json", JSON.stringify({ body: {} }), "{}"])("ignores %s", async (data) => {
    const received = captureTarget();

    await expect(forwardDelivery(data, DEFAULT_TARGET)).resolves.toBeNull();
    expect(received).toEqual([]);
  });
});

describe("relay", () => {
  it("forwards every delivery of the stream, reporting only event, ID and status", async () => {
    const received = captureTarget();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const text = `event: ready\ndata: {}\n\ndata: ${smeeMessage()}\n\nevent: ping\ndata: {}\n\ndata: ${smeeMessage({ "x-github-event": "workflow_run" })}\n\n`;
        // Split mid-event to exercise buffering.
        controller.enqueue(encoder.encode(text.slice(0, 50)));
        controller.enqueue(encoder.encode(text.slice(50)));
        controller.close();
      },
    });
    mockServer.use(
      http.get(CHANNEL, ({ request }) => {
        expect(request.headers.get("accept")).toBe("text/event-stream");
        return new HttpResponse(stream, { headers: { "content-type": "text/event-stream" } });
      }),
    );
    const delivered: RelayedDelivery[] = [];

    await relay({ smeeUrl: CHANNEL, target: DEFAULT_TARGET, onDelivery: (d) => delivered.push(d) });

    expect(delivered.map((d) => [d.event, d.status])).toEqual([
      ["installation", 202],
      ["workflow_run", 202],
    ]);
    expect(received).toHaveLength(2);
    expect(Object.keys(delivered[0] ?? {}).sort()).toEqual(["deliveryId", "event", "status"]);
  });

  it("fails when smee.io refuses the channel", async () => {
    mockServer.use(http.get(CHANNEL, () => new HttpResponse(null, { status: 404 })));

    await expect(
      relay({ smeeUrl: CHANNEL, target: DEFAULT_TARGET, onDelivery: () => undefined }),
    ).rejects.toThrow("smee.io answered 404");
  });
});

describe("relayEnvSchema", () => {
  it("defaults the target to the local webhook route", () => {
    expect(relayEnvSchema.parse({ SMEE_URL: CHANNEL })).toEqual({
      SMEE_URL: CHANNEL,
      WEBHOOK_TARGET: DEFAULT_TARGET,
    });
  });

  it.each([
    { SMEE_URL: "http://smee.io/x" },
    { SMEE_URL: "https://evil.example/x" },
    { SMEE_URL: CHANNEL, WEBHOOK_TARGET: "https://pipeheal.example/api/webhooks/github" },
    {},
  ])("rejects %o", (env) => {
    expect(relayEnvSchema.safeParse(env).success).toBe(false);
  });
});
