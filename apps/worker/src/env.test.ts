import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EnvValidationError } from "@pipeheal/shared";
import { describe, expect, it } from "vitest";
import { loadWorkerEnv, workerEnvSchema } from "./env";

function testPrivateKeyBase64(): string {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return Buffer.from(privateKey).toString("base64");
}

const githubApp = { GITHUB_APP_ID: "123456", GITHUB_APP_PRIVATE_KEY: testPrivateKeyBase64() };
const production = {
  NODE_ENV: "production",
  REDIS_URL: "rediss://cache.internal:6380",
  DATABASE_URL: "postgresql://app:pw@db.internal:5432/pipeheal?sslmode=verify-full",
  ...githubApp,
};

describe("worker env", () => {
  it("starts with local-dev defaults when nothing is set, GitHub App off", () => {
    expect(loadWorkerEnv({})).toEqual({
      NODE_ENV: "development",
      LOG_LEVEL: "info",
      REDIS_URL: "redis://localhost:6379",
      DATABASE_URL: "postgresql://pipeheal:pipeheal@localhost:5432/pipeheal",
      GATEWAY_HOST: "127.0.0.1",
      GATEWAY_PORT: 4000,
    });
  });

  it("decodes the GitHub App credentials when both are set", () => {
    const env = loadWorkerEnv(githubApp);

    expect(env.GITHUB_APP_ID).toBe(123456);
    expect(env.GITHUB_APP_PRIVATE_KEY).toMatch(/^-----BEGIN RSA PRIVATE KEY-----/);
  });

  it("requires both GitHub App settings together", () => {
    expect(() => loadWorkerEnv({ GITHUB_APP_ID: "123456" })).toThrow(EnvValidationError);
    expect(() => loadWorkerEnv({ GITHUB_APP_PRIVATE_KEY: testPrivateKeyBase64() })).toThrow(
      EnvValidationError,
    );
  });

  it.each(["http://localhost:6379", "localhost:6379"])("rejects REDIS_URL %s", (url) => {
    expect(() => loadWorkerEnv({ REDIS_URL: url })).toThrow(EnvValidationError);
  });

  it("accepts a complete production configuration", () => {
    expect(loadWorkerEnv(production)).toMatchObject({
      REDIS_URL: "rediss://cache.internal:6380",
      GITHUB_APP_ID: 123456,
    });
  });

  it("requires every production setting, with no localhost defaults", () => {
    expect(() => loadWorkerEnv({ NODE_ENV: "production" })).toThrow(EnvValidationError);
  });

  it("requires TLS REDIS_URL and DATABASE_URL in production (loopback excepted)", () => {
    expect(() =>
      loadWorkerEnv({ ...production, REDIS_URL: "redis://cache.internal:6379" }),
    ).toThrow(EnvValidationError);
    expect(() =>
      loadWorkerEnv({ ...production, DATABASE_URL: "postgresql://app:pw@db.internal/pipeheal" }),
    ).toThrow(EnvValidationError);

    const loopback = loadWorkerEnv({
      ...production,
      REDIS_URL: "redis://127.0.0.1:6379",
      DATABASE_URL: "postgresql://pipeheal:pipeheal@localhost:5432/pipeheal",
    });
    expect(loopback.REDIS_URL).toBe("redis://127.0.0.1:6379");
  });

  it("requires the GitHub App to be configured in production", () => {
    expect(() => loadWorkerEnv({ ...production, GITHUB_APP_ID: undefined })).toThrow(
      EnvValidationError,
    );
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
