// Development only: relays GitHub webhook deliveries from a smee.io channel to the local web app
// (`pnpm dev:webhooks`, docs/SETUP-GITHUB-APP.md). smee.io delivers each webhook as a
// server-sent event carrying the original headers and the JSON body.
import { isLoopbackUrl } from "@pipeheal/shared";
import { z } from "zod";

export const DEFAULT_TARGET = "http://localhost:3000/api/webhooks/github";

// Only these request headers are passed on: what GitHub signs and what the route reads.
const FORWARDED_HEADERS = [
  "x-github-event",
  "x-github-delivery",
  "x-github-hook-id",
  "x-github-hook-installation-target-id",
  "x-github-hook-installation-target-type",
  "x-hub-signature-256",
] as const;

export const relayEnvSchema = z.object({
  SMEE_URL: z.url({
    protocol: /^https$/,
    hostname: /^smee\.io$/,
    error: "must be an https://smee.io/<channel> URL",
  }),
  WEBHOOK_TARGET: z
    .url()
    .refine(isLoopbackUrl, "must point at this machine (localhost)")
    .default(DEFAULT_TARGET),
});

const deliverySchema = z.looseObject({
  body: z.unknown(),
  // Newer smee.io servers include the exact bytes GitHub signed; prefer them when present.
  rawBody: z.string().optional(),
  "x-github-event": z.string().optional(),
  "x-github-delivery": z.string().optional(),
});

export interface RelayedDelivery {
  event: string;
  deliveryId: string;
  status: number;
}

interface SseEvent {
  event: string;
  data: string;
}

/** Splits a server-sent event stream's text into complete events; returns the unfinished rest. */
export function parseSseEvents(text: string): { events: SseEvent[]; rest: string } {
  const blocks = text.replace(/\r\n/g, "\n").split("\n\n");
  const rest = blocks.pop() ?? "";
  const events = blocks.flatMap((block) => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    return data.length === 0 ? [] : [{ event, data: data.join("\n") }];
  });
  return { events, rest };
}

/** Forwards one smee message to the target. Returns null for messages that aren't deliveries. */
export async function forwardDelivery(
  data: string,
  target: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RelayedDelivery | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const delivery = deliverySchema.safeParse(parsed);
  if (!delivery.success || delivery.data["x-github-event"] === undefined) return null;

  const headers = new Headers({
    "content-type": "application/json",
    "user-agent": "pipeheal-dev-webhooks",
  });
  for (const name of FORWARDED_HEADERS) {
    const value = delivery.data[name];
    if (typeof value === "string") headers.set(name, value);
  }
  const response = await fetchImpl(target, {
    method: "POST",
    headers,
    body: delivery.data.rawBody ?? JSON.stringify(delivery.data.body),
  });
  return {
    event: delivery.data["x-github-event"],
    deliveryId: delivery.data["x-github-delivery"] ?? "unknown",
    status: response.status,
  };
}

/**
 * Streams the smee channel and forwards each delivery until the stream ends or `signal` aborts.
 * Reports only event names, delivery IDs and statuses: payloads hold customer data.
 */
export async function relay(options: {
  smeeUrl: string;
  target: string;
  onDelivery: (delivery: RelayedDelivery) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(options.smeeUrl, {
    headers: { accept: "text/event-stream" },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!response.ok || response.body === null) {
    throw new Error(`smee.io answered ${String(response.status)}`);
  }
  const decoder = new TextDecoder();
  // Node's fetch types its body stream loosely; it yields bytes.
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const { events, rest } = parseSseEvents(buffered + decoder.decode(value, { stream: true }));
    buffered = rest;
    for (const { event, data } of events) {
      if (event !== "message") continue;
      const delivery = await forwardDelivery(data, options.target, fetchImpl);
      if (delivery !== null) options.onDelivery(delivery);
    }
  }
}
