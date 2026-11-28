import { createLogger } from "@pipeheal/shared/logger";
import { BODY_LIMITS } from "@pipeheal/shared/protocol";
import { describe, expect, it } from "vitest";
import {
  CONNECTION_TIMEOUT_MS,
  HEADERS_TIMEOUT_MS,
  MAX_CONNECTIONS,
  REQUEST_TIMEOUT_MS,
  buildGateway,
  buildInternalServer,
  clientBucket,
  type GatewayOptions,
  type HealthCheck,
} from "./server";

const logger = createLogger({ level: "silent", service: "test" });

async function ready(checks: Record<string, HealthCheck>) {
  const app = buildInternalServer({ logger, checks, checkTimeoutMs: 50 });
  try {
    const response = await app.inject({ method: "GET", url: "/readyz" });
    return { status: response.statusCode, body: response.json<unknown>() };
  } finally {
    await app.close();
  }
}

/** A gateway with a tiny limit and a route added the way the runner routes will be (P4.2). */
async function limitedGateway(options: Partial<GatewayOptions> = {}) {
  const app = await buildGateway({
    logger,
    rateLimit: { max: 2, timeWindowMs: 60_000 },
    ...options,
  });
  app.get("/v1/probe", () => ({ ok: true }));
  const status = async (
    url: string,
    remoteAddress = "203.0.113.1",
    headers: Record<string, string> = {},
  ) => (await app.inject({ method: "GET", url, remoteAddress, headers })).statusCode;
  return { app, status };
}

describe("public gateway health", () => {
  it("answers /livez without checking dependencies", async () => {
    const app = await buildGateway({ logger });
    const response = await app.inject({ method: "GET", url: "/livez" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: "gateway" });
  });

  it("doesn't expose readiness or the old /health to runners", async () => {
    const app = await buildGateway({ logger });
    const statuses = await Promise.all(
      ["/readyz", "/health", "/v1/unknown"].map(
        async (url) => (await app.inject({ method: "GET", url })).statusCode,
      ),
    );
    await app.close();

    expect(statuses).toEqual([404, 404, 404]);
  });

  it("sets header, request and idle deadlines and a connection cap on both listeners", async () => {
    const servers = [await buildGateway({ logger }), buildInternalServer({ logger, checks: {} })];
    for (const app of servers) {
      await app.ready();
      expect(app.server.requestTimeout).toBe(REQUEST_TIMEOUT_MS);
      expect(app.server.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
      expect(app.server.timeout).toBe(CONNECTION_TIMEOUT_MS);
      expect(app.server.maxConnections).toBe(MAX_CONNECTIONS);
      await app.close();
    }
    expect(HEADERS_TIMEOUT_MS).toBeLessThan(REQUEST_TIMEOUT_MS);
  });
});

describe("internal GET /readyz", () => {
  it("is 200 when every check is up", async () => {
    expect(await ready({ redis: () => Promise.resolve(true) })).toEqual({
      status: 200,
      body: { status: "ok", service: "gateway", checks: { redis: "up" } },
    });
  });

  it("is 503 when a check reports down", async () => {
    const result = await ready({
      redis: () => Promise.resolve(false),
      other: () => Promise.resolve(true),
    });
    expect(result).toEqual({
      status: 503,
      body: { status: "degraded", service: "gateway", checks: { redis: "down", other: "up" } },
    });
  });

  it("treats a throwing check as down", async () => {
    const result = await ready({ redis: () => Promise.reject(new Error("ECONNREFUSED")) });
    expect(result.status).toBe(503);
  });

  it("treats a hanging check as down after the timeout", async () => {
    const result = await ready({ redis: () => new Promise<boolean>(() => undefined) });
    expect(result).toMatchObject({ status: 503, body: { checks: { redis: "down" } } });
  });
});

describe("body limits", () => {
  it("refuses a body over the small default, and lets a route opt into its protocol limit", async () => {
    const app = await buildGateway({ logger });
    app.post("/small", () => ({ ok: true }));
    app.post("/session-sized", { bodyLimit: BODY_LIMITS.session }, () => ({ ok: true }));
    app.post("/step-sized", { bodyLimit: BODY_LIMITS.step }, () => ({ ok: true }));
    const body = (bytes: number) => ({ padding: "x".repeat(bytes) });

    const small = await app.inject({ method: "POST", url: "/small", payload: body(100) });
    const tooBig = await app.inject({
      method: "POST",
      url: "/small",
      payload: body(BODY_LIMITS.default),
    });
    const tooBigSession = await app.inject({
      method: "POST",
      url: "/session-sized",
      payload: body(BODY_LIMITS.session),
    });
    const step = await app.inject({ method: "POST", url: "/step-sized", payload: body(1_000_000) });
    await app.close();

    expect(small.statusCode).toBe(200);
    expect(tooBig.statusCode).toBe(413);
    expect(tooBigSession.statusCode).toBe(413);
    expect(step.statusCode).toBe(200);
  });
});

describe("rate limits", () => {
  it("counts routes added after the gateway is built, with a 429 past the limit", async () => {
    const { app, status } = await limitedGateway();
    const statuses = [
      await status("/v1/probe"),
      await status("/v1/probe"),
      await status("/v1/probe"),
    ];
    const limited = await app.inject({
      method: "GET",
      url: "/v1/probe",
      remoteAddress: "203.0.113.1",
    });
    await app.close();

    expect(statuses).toEqual([200, 200, 429]);
    expect(limited.json<{ error: string }>().error).toMatch(/^rate limit exceeded/);
  });

  it("counts unknown paths too, but never /livez", async () => {
    const { app, status } = await limitedGateway();
    const missing = [await status("/nope"), await status("/nope"), await status("/nope")];
    const live = [await status("/livez"), await status("/livez"), await status("/livez")];
    await app.close();

    expect(missing).toEqual([404, 404, 429]);
    expect(live).toEqual([200, 200, 200]);
  });

  it("gives a made-up bearer token no fresh budget", async () => {
    const { app, status } = await limitedGateway();
    const statuses = [];
    for (const token of ["a", "b", "c"]) {
      statuses.push(
        await status("/v1/probe", "203.0.113.1", { authorization: `Bearer ${token.repeat(43)}` }),
      );
    }
    await app.close();

    expect(statuses).toEqual([200, 200, 429]);
  });

  it("puts one IPv6 /64 in one bucket, and other clients in their own", async () => {
    const { app, status } = await limitedGateway();
    const sameNetwork = [
      await status("/v1/probe", "2001:db8:1:2::1"),
      await status("/v1/probe", "2001:db8:1:2:ffff::9"),
      await status("/v1/probe", "2001:db8:1:2:abcd:1:2:3"),
    ];
    const otherNetwork = await status("/v1/probe", "2001:db8:1:3::1");
    const otherV4 = await status("/v1/probe", "198.51.100.7");
    await app.close();

    expect(sameNetwork).toEqual([200, 200, 429]);
    expect(otherNetwork).toBe(200);
    expect(otherV4).toBe(200);
  });

  it("believes X-Forwarded-For only from a trusted proxy", async () => {
    const forwarded = (client: string) => ({ "x-forwarded-for": client });
    const trusting = await limitedGateway({ trustedProxies: ["10.0.0.0/8"] });
    // Behind the proxy, two runners keep separate budgets.
    const behindProxy = [
      await trusting.status("/v1/probe", "10.0.0.5", forwarded("203.0.113.1")),
      await trusting.status("/v1/probe", "10.0.0.5", forwarded("203.0.113.1")),
      await trusting.status("/v1/probe", "10.0.0.5", forwarded("203.0.113.1")),
      await trusting.status("/v1/probe", "10.0.0.5", forwarded("203.0.113.2")),
    ];
    await trusting.app.close();
    // From anyone else the header is ignored, so it can't buy a fresh budget.
    const plain = await limitedGateway();
    const spoofed = [];
    for (const client of ["192.0.2.1", "192.0.2.2", "192.0.2.3"]) {
      spoofed.push(await plain.status("/v1/probe", "203.0.113.9", forwarded(client)));
    }
    await plain.app.close();

    expect(behindProxy).toEqual([200, 200, 429, 200]);
    expect(spoofed).toEqual([200, 200, 429]);
  });

  it.each([
    ["203.0.113.1", "203.0.113.1"],
    ["::ffff:203.0.113.1", "203.0.113.1"],
    ["2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"],
    ["2001:0db8:0001:0002::1", "2001:db8:1:2::/64"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
  ])("buckets %s as %s", (ip, bucket) => {
    expect(clientBucket(ip)).toBe(bucket);
  });
});

describe("gateway logging and error responses", () => {
  const TOKEN = "ghs_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

  it("never leaks query strings, headers or error details to logs or clients", async () => {
    const lines: string[] = [];
    const capture = createLogger(
      { level: "info", service: "test" },
      { write: (l) => lines.push(l) },
    );
    const app = await buildGateway({ logger: capture });
    app.get("/boom", () => {
      throw Object.assign(new Error(`upstream rejected ${TOKEN}`), {
        response: { headers: { authorization: "Bearer leaked-header" } },
      });
    });

    await app.inject({
      method: "GET",
      url: `/livez?token=${TOKEN}&code=oauth-code-value`,
      headers: { authorization: `Bearer ${TOKEN}`, cookie: "sid=cookie-value" },
    });
    const boom = await app.inject({ method: "GET", url: "/boom" });
    const missing = await app.inject({ method: "GET", url: `/nope?token=${TOKEN}` });
    await app.close();

    const logs = lines.join("");
    for (const secret of [TOKEN, "oauth-code-value", "leaked-header", "cookie-value"]) {
      expect(logs).not.toContain(secret);
    }
    expect(logs).toContain("/livez");
    expect(boom.statusCode).toBe(500);
    expect(boom.body).not.toContain(TOKEN);
    expect(boom.json()).toEqual({ error: "internal error" });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).not.toContain(TOKEN);
  });

  it("keeps 4xx statuses from thrown errors, with the message redacted", async () => {
    const app = await buildGateway({ logger });
    app.get("/forbidden", () => {
      throw Object.assign(new Error(`forbidden for ${TOKEN}`), { statusCode: 403 });
    });
    const response = await app.inject({ method: "GET", url: "/forbidden" });
    await app.close();
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "forbidden for [redacted]" });
  });

  it("handles unknown routes the same way internally", async () => {
    const app = buildInternalServer({ logger, checks: {} });
    const response = await app.inject({ method: "GET", url: `/nope?token=${TOKEN}` });
    await app.close();
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(TOKEN);
  });
});
