import { createLogger } from "@pipeheal/shared/logger";
import { describe, expect, it } from "vitest";
import { buildGateway, type HealthCheck } from "./server";

const logger = createLogger({ level: "silent", service: "test" });

async function health(checks: Record<string, HealthCheck>) {
  const app = buildGateway({ logger, checks, checkTimeoutMs: 50 });
  try {
    const response = await app.inject({ method: "GET", url: "/health" });
    return { status: response.statusCode, body: response.json<unknown>() };
  } finally {
    await app.close();
  }
}

describe("gateway GET /health", () => {
  it("is 200 when every check is up", async () => {
    expect(await health({ redis: () => Promise.resolve(true) })).toEqual({
      status: 200,
      body: { status: "ok", service: "gateway", checks: { redis: "up" } },
    });
  });

  it("is 503 when a check reports down", async () => {
    const result = await health({
      redis: () => Promise.resolve(false),
      other: () => Promise.resolve(true),
    });
    expect(result).toEqual({
      status: 503,
      body: { status: "degraded", service: "gateway", checks: { redis: "down", other: "up" } },
    });
  });

  it("treats a throwing check as down", async () => {
    const result = await health({ redis: () => Promise.reject(new Error("ECONNREFUSED")) });
    expect(result.status).toBe(503);
  });

  it("treats a hanging check as down after the timeout", async () => {
    const result = await health({ redis: () => new Promise<boolean>(() => undefined) });
    expect(result).toMatchObject({ status: 503, body: { checks: { redis: "down" } } });
  });

  it("returns 404 for unknown routes", async () => {
    const app = buildGateway({ logger, checks: {} });
    const response = await app.inject({ method: "GET", url: "/v1/unknown" });
    await app.close();
    expect(response.statusCode).toBe(404);
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
    const app = buildGateway({ logger: capture, checks: {} });
    app.get("/boom", () => {
      throw Object.assign(new Error(`upstream rejected ${TOKEN}`), {
        response: { headers: { authorization: "Bearer leaked-header" } },
      });
    });

    await app.inject({
      method: "GET",
      url: `/health?token=${TOKEN}&code=oauth-code-value`,
      headers: { authorization: `Bearer ${TOKEN}`, cookie: "sid=cookie-value" },
    });
    const boom = await app.inject({ method: "GET", url: "/boom" });
    const missing = await app.inject({ method: "GET", url: `/nope?token=${TOKEN}` });
    await app.close();

    const logs = lines.join("");
    for (const secret of [TOKEN, "oauth-code-value", "leaked-header", "cookie-value"]) {
      expect(logs).not.toContain(secret);
    }
    expect(logs).toContain("/health");
    expect(boom.statusCode).toBe(500);
    expect(boom.body).not.toContain(TOKEN);
    expect(boom.json()).toEqual({ error: "internal error" });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).not.toContain(TOKEN);
  });

  it("keeps 4xx statuses from thrown errors, with the message redacted", async () => {
    const app = buildGateway({ logger, checks: {} });
    app.get("/forbidden", () => {
      throw Object.assign(new Error(`forbidden for ${TOKEN}`), { statusCode: 403 });
    });
    const response = await app.inject({ method: "GET", url: "/forbidden" });
    await app.close();
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "forbidden for [redacted]" });
  });
});
