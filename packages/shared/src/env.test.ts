import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  EnvValidationError,
  envBoolean,
  envHttpUrl,
  envPort,
  isLoopbackUrl,
  parseEnv,
  publicSecretNames,
  secureUnlessLoopback,
} from "./env";

const schema = z.object({
  DATABASE_URL: z.url(),
  GATEWAY_PORT: envPort.default(4000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  FEATURE_FLAG: envBoolean.default(false),
  WEBHOOK_SECRET: z.string().min(32),
});

const valid = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  WEBHOOK_SECRET: "x".repeat(32),
};

function captureError(fn: () => unknown): EnvValidationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error("expected parseEnv to throw");
}

describe("parseEnv", () => {
  it("returns typed values with defaults applied", () => {
    const env = parseEnv(schema, { ...valid, GATEWAY_PORT: "4100", FEATURE_FLAG: "true" });
    expect(env).toEqual({
      DATABASE_URL: valid.DATABASE_URL,
      GATEWAY_PORT: 4100,
      LOG_LEVEL: "info",
      FEATURE_FLAG: true,
      WEBHOOK_SECRET: valid.WEBHOOK_SECRET,
    });
  });

  it("treats empty strings as unset, so defaults apply", () => {
    const env = parseEnv(schema, { ...valid, GATEWAY_PORT: "", LOG_LEVEL: "" });
    expect(env.GATEWAY_PORT).toBe(4000);
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("ignores variables the schema does not declare", () => {
    const env = parseEnv(schema, { ...valid, PATH: "/usr/bin" });
    expect(env).not.toHaveProperty("PATH");
  });

  it("reports every missing or invalid key, sorted, in one error", () => {
    const error = captureError(() =>
      parseEnv(schema, { GATEWAY_PORT: "70000", LOG_LEVEL: "loud", DATABASE_URL: "" }),
    );
    expect(error.keys).toEqual(["DATABASE_URL", "GATEWAY_PORT", "LOG_LEVEL", "WEBHOOK_SECRET"]);
    expect(error.message).toMatch(/^Invalid environment/);
    for (const key of error.keys) expect(error.message).toContain(key);
  });

  it("never echoes values in the error, even for invalid secrets", () => {
    const leaked = "ghp_thisLooksLikeARealTokenValue";
    const error = captureError(() =>
      parseEnv(schema, { ...valid, WEBHOOK_SECRET: leaked, DATABASE_URL: `not a url ${leaked}` }),
    );
    expect(error.message).not.toContain(leaked);
    expect(JSON.stringify(error.issues)).not.toContain(leaked);
  });
});

describe("envPort", () => {
  it.each([
    ["1", 1],
    ["65535", 65535],
  ])("accepts %s", (raw, expected) => {
    expect(envPort.parse(raw)).toBe(expected);
  });

  it.each(["0", "65536", "80.5", "http", "-1"])("rejects %s", (raw) => {
    expect(envPort.safeParse(raw).success).toBe(false);
  });
});

describe("envHttpUrl", () => {
  it.each(["http://localhost:3000", "https://pipeheal.example/app"])("accepts %s", (raw) => {
    expect(envHttpUrl.parse(raw)).toBe(raw);
  });

  // "localhost:3000" is a valid WHATWG URL with scheme "localhost:", so plain z.url() accepts it.
  it.each(["localhost:3000", "ftp://example.com", "javascript:alert(1)", "not a url"])(
    "rejects %s",
    (raw) => {
      expect(envHttpUrl.safeParse(raw).success).toBe(false);
    },
  );
});

describe("envBoolean", () => {
  it.each([
    ["true", true],
    ["1", true],
    ["false", false],
    ["0", false],
  ])("parses %s", (raw, expected) => {
    expect(envBoolean.parse(raw)).toBe(expected);
  });

  it.each(["yes", "TRUE ", "on", ""])("rejects %j", (raw) => {
    expect(envBoolean.safeParse(raw).success).toBe(false);
  });
});

describe("publicSecretNames", () => {
  it("flags NEXT_PUBLIC_ variables whose names look like secrets", () => {
    expect(
      publicSecretNames({
        NEXT_PUBLIC_APP_NAME: "PipeHeal",
        NEXT_PUBLIC_GITHUB_CLIENT_SECRET: "x",
        NEXT_PUBLIC_ANTHROPIC_API_KEY: "y",
        NEXT_PUBLIC_SENTRY_DSN: "z",
        GITHUB_CLIENT_SECRET: "server-side is fine",
      }).sort(),
    ).toEqual([
      "NEXT_PUBLIC_ANTHROPIC_API_KEY",
      "NEXT_PUBLIC_GITHUB_CLIENT_SECRET",
      "NEXT_PUBLIC_SENTRY_DSN",
    ]);
  });

  it("returns nothing when no public variable looks secret", () => {
    expect(publicSecretNames({ NEXT_PUBLIC_APP_NAME: "PipeHeal", PATH: "/bin" })).toEqual([]);
  });
});

describe("secureUnlessLoopback", () => {
  it.each([
    ["https://pipeheal.example", "https:"],
    ["http://localhost:3000", "https:"],
    ["http://127.0.0.1:3100", "https:"],
    ["http://[::1]:3000", "https:"],
    ["rediss://cache.internal:6380", "rediss:"],
    ["redis://localhost:6379", "rediss:"],
  ] as const)("accepts %s", (url, secure) => {
    expect(secureUnlessLoopback(url, secure)).toBe(true);
  });

  it.each([
    ["http://pipeheal.example", "https:"],
    ["redis://cache.internal:6379", "rediss:"],
    ["http://localhost.evil.example", "https:"],
  ] as const)("rejects %s", (url, secure) => {
    expect(secureUnlessLoopback(url, secure)).toBe(false);
  });
});

describe("isLoopbackUrl", () => {
  it.each([
    "postgresql://pipeheal:pipeheal@localhost:5432/pipeheal",
    "http://127.0.0.1:3100",
    "redis://[::1]:6379",
  ])("accepts %s", (url) => {
    expect(isLoopbackUrl(url)).toBe(true);
  });

  it.each([
    "postgresql://db.internal:5432/pipeheal",
    "http://localhost.evil.example",
    "http://127.0.0.2.evil.example",
  ])("rejects %s", (url) => {
    expect(isLoopbackUrl(url)).toBe(false);
  });
});
