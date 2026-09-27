import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EnvValidationError } from "@pipeheal/shared";
import { describe, expect, it } from "vitest";
import { githubSignInConfig, loadWebEnv, webEnvSchema } from "./env";

const signIn = {
  BETTER_AUTH_SECRET: "x".repeat(32),
  GITHUB_CLIENT_ID: "Iv23-test-client",
  GITHUB_CLIENT_SECRET: "test-client-secret",
};
const production = {
  NODE_ENV: "production",
  APP_URL: "https://pipeheal.example",
  DATABASE_URL: "postgresql://app:pw@db.internal:5432/pipeheal?sslmode=verify-full",
  REDIS_URL: "rediss://cache.internal:6380",
  GITHUB_WEBHOOK_SECRET: "w".repeat(32),
  ...signIn,
};

function problemKeys(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof EnvValidationError) return error.keys;
    throw error;
  }
  return [];
}

describe("web env", () => {
  it("starts with local-dev defaults when nothing is set, sign-in and webhooks off", () => {
    const env = loadWebEnv({});
    expect(env).toEqual({
      NODE_ENV: "development",
      LOG_LEVEL: "info",
      APP_URL: "http://localhost:3000",
      DATABASE_URL: "postgresql://pipeheal:pipeheal@localhost:5432/pipeheal",
      REDIS_URL: "redis://localhost:6379",
    });
    expect(githubSignInConfig(env)).toBeNull();
  });

  it("turns GitHub sign-in on when its three settings are set", () => {
    expect(githubSignInConfig(loadWebEnv(signIn))).toEqual({
      secret: signIn.BETTER_AUTH_SECRET,
      clientId: signIn.GITHUB_CLIENT_ID,
      clientSecret: signIn.GITHUB_CLIENT_SECRET,
    });
  });

  it("names the missing sign-in settings when only some are set", () => {
    expect(problemKeys(() => loadWebEnv({ GITHUB_CLIENT_ID: "Iv23-test-client" }))).toEqual([
      "BETTER_AUTH_SECRET",
      "GITHUB_CLIENT_SECRET",
    ]);
  });

  it("requires a BETTER_AUTH_SECRET of at least 32 characters", () => {
    expect(problemKeys(() => loadWebEnv({ ...signIn, BETTER_AUTH_SECRET: "short" }))).toEqual([
      "BETTER_AUTH_SECRET",
    ]);
  });

  it("accepts a complete production configuration", () => {
    expect(loadWebEnv(production).APP_URL).toBe("https://pipeheal.example");
  });

  it("requires every production setting, with no localhost defaults", () => {
    expect(problemKeys(() => loadWebEnv({ NODE_ENV: "production" }))).toEqual([
      "APP_URL",
      "BETTER_AUTH_SECRET",
      "DATABASE_URL",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "GITHUB_WEBHOOK_SECRET",
      "REDIS_URL",
    ]);
  });

  it("requires https and database TLS in production (loopback excepted)", () => {
    expect(
      problemKeys(() => loadWebEnv({ ...production, APP_URL: "http://pipeheal.example" })),
    ).toEqual(["APP_URL"]);
    expect(
      problemKeys(() =>
        loadWebEnv({ ...production, DATABASE_URL: "postgresql://app:pw@db.internal/pipeheal" }),
      ),
    ).toEqual(["DATABASE_URL"]);
    const loopback = loadWebEnv({
      ...production,
      APP_URL: "http://127.0.0.1:3100",
      DATABASE_URL: "postgresql://pipeheal:pipeheal@localhost:5432/pipeheal",
    });
    expect(loopback.APP_URL).toBe("http://127.0.0.1:3100");
  });

  it("requires rediss:// and a real webhook secret in production (loopback excepted)", () => {
    expect(
      problemKeys(() => loadWebEnv({ ...production, REDIS_URL: "redis://cache.internal:6379" })),
    ).toEqual(["REDIS_URL"]);
    expect(
      problemKeys(() => loadWebEnv({ ...production, GITHUB_WEBHOOK_SECRET: "short" })),
    ).toEqual(["GITHUB_WEBHOOK_SECRET"]);
    const loopback = loadWebEnv({ ...production, REDIS_URL: "redis://localhost:6379" });
    expect(loopback.REDIS_URL).toBe("redis://localhost:6379");
  });

  it("never echoes a secret value in its errors", () => {
    const run = () => loadWebEnv({ ...production, DATABASE_URL: "mysql://app:hunter2@db/x" });
    expect(run).toThrow(EnvValidationError);
    expect(run).not.toThrow(/hunter2/);
  });

  it("refuses NEXT_PUBLIC_ variables that look like secrets", () => {
    expect(() => loadWebEnv({ NEXT_PUBLIC_GITHUB_CLIENT_SECRET: "x" })).toThrow(
      /NEXT_PUBLIC_GITHUB_CLIENT_SECRET/,
    );
  });

  it("rejects an invalid APP_URL", () => {
    expect(() => loadWebEnv({ APP_URL: "localhost:3000" })).toThrow(EnvValidationError);
  });

  it("documents every variable it reads in .env.example", () => {
    const example = readFileSync(
      fileURLToPath(new URL("../../../.env.example", import.meta.url)),
      "utf8",
    );
    for (const key of Object.keys(webEnvSchema.shape)) {
      expect(example).toMatch(new RegExp(`^${key}=`, "m"));
    }
  });
});
