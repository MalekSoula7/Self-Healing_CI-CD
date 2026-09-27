import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EnvValidationError, envBoolean, envPort, parseEnv } from "./env";

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
