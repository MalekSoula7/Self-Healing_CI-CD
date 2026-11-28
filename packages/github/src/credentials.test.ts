import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  PrivateKeyError,
  decodePrivateKey,
  githubAppIdSchema,
  githubPrivateKeySchema,
  webhookSecretSchema,
} from "./credentials";

function rsaPem(type: "pkcs1" | "pkcs8"): string {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type, format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
}

const base64 = (text: string) => Buffer.from(text).toString("base64");

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("decodePrivateKey", () => {
  it.each(["pkcs1", "pkcs8"] as const)("decodes a base64 %s PEM, as GitHub gives it", (type) => {
    const pem = rsaPem(type);
    expect(decodePrivateKey(base64(pem))).toBe(pem);
  });

  it("tolerates line-wrapped base64 and CRLF line endings (a key saved on Windows)", () => {
    const pem = rsaPem("pkcs1");
    const wrapped = base64(pem.replace(/\n/g, "\r\n")).replace(/(.{76})/g, "$1\n");
    expect(decodePrivateKey(wrapped)).toBe(pem);
  });

  it.each([
    ["the raw PEM instead of base64", rsaPem("pkcs1")],
    ["base64 of something else", base64("hello")],
    ["an empty value", ""],
    [
      "a public key",
      base64(
        generateKeyPairSync("rsa", {
          modulusLength: 2048,
          publicKeyEncoding: { type: "spki", format: "pem" },
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
        }).publicKey,
      ),
    ],
    ["a corrupted key", base64(rsaPem("pkcs1").replace(/\n[A-Za-z0-9+/]{10}/, "\nAAAAAAAAAA"))],
  ])("rejects %s without echoing it", (_label, value) => {
    const error = thrownBy(() => decodePrivateKey(value));
    expect(error).toBeInstanceOf(PrivateKeyError);
    expect(String(error)).not.toContain(value.slice(0, 40) || "\u0000");
  });

  it("rejects a non-RSA key", () => {
    const ec = generateKeyPairSync("ec", {
      namedCurve: "P-256",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    expect(() => decodePrivateKey(base64(ec))).toThrow(/not an RSA key/);
  });
});

describe("env schema pieces", () => {
  const schema = z.object({
    GITHUB_APP_ID: githubAppIdSchema,
    GITHUB_APP_PRIVATE_KEY: githubPrivateKeySchema,
    GITHUB_WEBHOOK_SECRET: webhookSecretSchema,
  });

  it("parses valid settings", () => {
    const pem = rsaPem("pkcs1");
    expect(
      schema.parse({
        GITHUB_APP_ID: "123456",
        GITHUB_APP_PRIVATE_KEY: base64(pem),
        GITHUB_WEBHOOK_SECRET: "w".repeat(32),
      }),
    ).toEqual({
      GITHUB_APP_ID: 123456,
      GITHUB_APP_PRIVATE_KEY: pem,
      GITHUB_WEBHOOK_SECRET: "w".repeat(32),
    });
  });

  it("reports each problem by name, without values", () => {
    const result = schema.safeParse({
      GITHUB_APP_ID: "my-app",
      GITHUB_APP_PRIVATE_KEY: "not-a-key",
      GITHUB_WEBHOOK_SECRET: "short",
    });
    expect(result.success).toBe(false);
    const issues = result.error?.issues.map((issue) => [issue.path[0], issue.message]) ?? [];
    expect(issues).toEqual([
      ["GITHUB_APP_ID", "must be the App's numeric ID"],
      ["GITHUB_APP_PRIVATE_KEY", "the private key is not base64"],
      ["GITHUB_WEBHOOK_SECRET", "must be at least 32 characters"],
    ]);
    expect(JSON.stringify(result.error)).not.toContain("not-a-key");
  });
});
