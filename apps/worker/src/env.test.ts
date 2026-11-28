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
const ollama = { OLLAMA_URL: "http://localhost:11434" };
const production = {
  NODE_ENV: "production",
  REDIS_URL: "rediss://cache.internal:6380",
  DATABASE_URL: "postgresql://app:pw@db.internal:5432/pipeheal?sslmode=verify-full",
  ...githubApp,
  GITHUB_APP_SLUG: "pipeheal",
  ...ollama,
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
      GATEWAY_INTERNAL_HOST: "127.0.0.1",
      GATEWAY_INTERNAL_PORT: 4001,
      GATEWAY_TRUSTED_PROXIES: [],
      OLLAMA_URL: "http://localhost:11434",
      TRIAGE_MODEL: "qwen3:14b",
      HEAL_MODEL: "qwen3:14b",
      HEAL_DISPATCH: false,
    });
  });

  it("turns the dispatcher on only when HEAL_DISPATCH says true", () => {
    expect(loadWorkerEnv({ HEAL_DISPATCH: "true" }).HEAL_DISPATCH).toBe(true);
    expect(loadWorkerEnv({ HEAL_DISPATCH: "false" }).HEAL_DISPATCH).toBe(false);
    expect(() => loadWorkerEnv({ HEAL_DISPATCH: "maybe" })).toThrow(EnvValidationError);
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
    // The session exchange checks runs against `<slug>[bot]` (SPEC §5.4).
    expect(() => loadWorkerEnv({ ...production, GITHUB_APP_SLUG: undefined })).toThrow(
      EnvValidationError,
    );
  });

  it("reads the App slug, and refuses one that isn't a slug", () => {
    expect(loadWorkerEnv({ GITHUB_APP_SLUG: "pipeheal-dev" }).GITHUB_APP_SLUG).toBe("pipeheal-dev");
    expect(loadWorkerEnv({}).GITHUB_APP_SLUG).toBeUndefined();
    expect(() => loadWorkerEnv({ GITHUB_APP_SLUG: "evil[bot]" })).toThrow(EnvValidationError);
  });

  it("reads trusted proxies, refuses anything but addresses and CIDRs, and keeps ports apart", () => {
    expect(
      loadWorkerEnv({ GATEWAY_TRUSTED_PROXIES: "10.0.0.0/8, 192.168.1.5,fd00::/8" })
        .GATEWAY_TRUSTED_PROXIES,
    ).toEqual(["10.0.0.0/8", "192.168.1.5", "fd00::/8"]);
    for (const bad of ["*", "true", "10.0.0.0/33", "loopback", "10.0.0.1/8/1"]) {
      expect(() => loadWorkerEnv({ GATEWAY_TRUSTED_PROXIES: bad })).toThrow(EnvValidationError);
    }
    expect(() => loadWorkerEnv({ GATEWAY_INTERNAL_PORT: "4000" })).toThrow(EnvValidationError);
    expect(() => loadWorkerEnv({ ...production, GATEWAY_INTERNAL_PORT: "4000" })).toThrow(
      EnvValidationError,
    );
  });

  it("reads the Ollama server and the triage model (D11)", () => {
    expect(
      loadWorkerEnv({ OLLAMA_URL: "http://192.168.1.20:11434", TRIAGE_MODEL: "qwen2.5-coder:14b" }),
    ).toMatchObject({ OLLAMA_URL: "http://192.168.1.20:11434", TRIAGE_MODEL: "qwen2.5-coder:14b" });
    expect(loadWorkerEnv({ TRIAGE_MODEL: "hf.co/org/model:Q4_K_M" }).TRIAGE_MODEL).toBe(
      "hf.co/org/model:Q4_K_M",
    );
  });

  it.each([
    ["an OLLAMA_URL that isn't http(s)", { OLLAMA_URL: "ollama:11434" }],
    ["a model tag with spaces", { TRIAGE_MODEL: "qwen3 14b" }],
  ])("refuses %s", (_case, source) => {
    expect(() => loadWorkerEnv(source)).toThrow(EnvValidationError);
  });

  it("requires OLLAMA_URL in production, https unless on this host", () => {
    expect(() => loadWorkerEnv({ ...production, OLLAMA_URL: undefined })).toThrow(
      EnvValidationError,
    );
    expect(() => loadWorkerEnv({ ...production, OLLAMA_URL: "http://gpu.internal:11434" })).toThrow(
      EnvValidationError,
    );
    expect(
      loadWorkerEnv({ ...production, OLLAMA_URL: "https://gpu.internal:11434" }).OLLAMA_URL,
    ).toBe("https://gpu.internal:11434");
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
