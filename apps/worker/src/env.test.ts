import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EnvValidationError } from "@pipeheal/shared";
import { describe, expect, it } from "vitest";
import { loadWorkerEnv, workerEnvSchema } from "./env";

describe("worker env", () => {
  it("starts with local-dev defaults when nothing is set", () => {
    expect(loadWorkerEnv({})).toEqual({
      NODE_ENV: "development",
      LOG_LEVEL: "info",
      REDIS_URL: "redis://localhost:6379",
      GATEWAY_HOST: "127.0.0.1",
      GATEWAY_PORT: 4000,
    });
  });

  it.each(["http://localhost:6379", "localhost:6379"])("rejects REDIS_URL %s", (url) => {
    expect(() => loadWorkerEnv({ REDIS_URL: url })).toThrow(EnvValidationError);
  });

  it("requires a TLS REDIS_URL in production (loopback excepted)", () => {
    expect(() => loadWorkerEnv({ NODE_ENV: "production" })).toThrow(EnvValidationError);
    expect(() =>
      loadWorkerEnv({ NODE_ENV: "production", REDIS_URL: "redis://cache.internal:6379" }),
    ).toThrow(EnvValidationError);
    expect(
      loadWorkerEnv({ NODE_ENV: "production", REDIS_URL: "rediss://cache.internal:6380" })
        .REDIS_URL,
    ).toBe("rediss://cache.internal:6380");
    expect(
      loadWorkerEnv({ NODE_ENV: "production", REDIS_URL: "redis://127.0.0.1:6379" }).REDIS_URL,
    ).toBe("redis://127.0.0.1:6379");
  });

  it("accepts TLS Redis URLs", () => {
    expect(loadWorkerEnv({ REDIS_URL: "rediss://cache.internal:6380" }).REDIS_URL).toBe(
      "rediss://cache.internal:6380",
    );
  });

  it("documents every variable it reads in .env.example", () => {
    const example = readFileSync(
      fileURLToPath(new URL("../../../.env.example", import.meta.url)),
      "utf8",
    );
    for (const key of Object.keys(workerEnvSchema.shape)) {
      expect(example).toMatch(new RegExp(`^${key}=`, "m"));
    }
  });
});
