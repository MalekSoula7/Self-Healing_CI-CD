import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { buildGateway, type HealthCheck } from "./server";

const logger = pino({ level: "silent" });

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
