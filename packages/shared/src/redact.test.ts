import { describe, expect, it } from "vitest";
import { REDACTED, redactText, redactValue } from "./redact";

// Fake secrets with the real formats. None of these are live credentials.
const GITHUB_TOKENS = [
  "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
  "gho_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
  "ghu_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
  "ghs_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
  "ghr_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
  "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP",
];
const ANTHROPIC_KEY = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEf";
const JWT =
  "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJyZXBvOmFjbWUvYXBpIn0.c2lnbmF0dXJlLXZhbHVlLWhlcmU";
const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAxfakefakefakefakefakefakefakefake",
  "-----END RSA PRIVATE KEY-----",
].join("\n");
const AWS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";

describe("redactText", () => {
  it.each(GITHUB_TOKENS)("removes the GitHub token %s", (token) => {
    const out = redactText(`auth failed for ${token} at step 3`);
    expect(out).not.toContain(token);
    expect(out).toBe(`auth failed for ${REDACTED} at step 3`);
  });

  it.each([
    ["an Anthropic key", `key=${ANTHROPIC_KEY}`, ANTHROPIC_KEY],
    ["a JWT", `oidc token ${JWT} rejected`, JWT],
    ["an AWS access key id", `using ${AWS_KEY_ID}`, AWS_KEY_ID],
  ])("removes %s", (_label, text, secret) => {
    expect(redactText(text)).not.toContain(secret);
  });

  it("removes a whole PEM private key block", () => {
    const out = redactText(`loaded key:\n${PEM}\nok`);
    expect(out).not.toContain("MIIEow");
    expect(out).toBe(`loaded key:\n${REDACTED}\nok`);
  });

  it("removes credentials embedded in URLs but keeps the host", () => {
    const out = redactText("connect redis://:s3cret-pass@cache.internal:6379 failed");
    expect(out).not.toContain("s3cret-pass");
    expect(out).toContain("cache.internal:6379");
    expect(redactText("postgres://app:hunter2@db:5432/pipeheal")).not.toContain("hunter2");
  });

  it("removes signed and token-bearing query parameters", () => {
    const url =
      "https://pipelines.actions.githubusercontent.com/logs/1?sig=AbC123%2Bsecret&se=2026-09-27&X-Amz-Signature=deadbeef&token=t0ken&code=oauthcode&page=2";
    const out = redactText(url);
    for (const secret of ["AbC123%2Bsecret", "deadbeef", "t0ken", "oauthcode"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("page=2");
    expect(out).toContain("se=2026-09-27");
  });

  it("removes bearer and token authorization values", () => {
    expect(redactText("Authorization: Bearer abcdefghijklmnop.qrstuvwxyz")).not.toContain(
      "abcdefghijklmnop",
    );
    expect(redactText("authorization: token 0123456789abcdef0123")).not.toContain(
      "0123456789abcdef0123",
    );
  });

  it("leaves ordinary text alone", () => {
    const text = "Job 123 in acme/api failed: expected 2 to be 3 (TS2345) at src/app.ts:14";
    expect(redactText(text)).toBe(text);
  });
});

describe("redactValue", () => {
  it("redacts secret-looking keys at any depth, case-insensitively", () => {
    const input = {
      attemptId: "att_1",
      github: { auth: { Token: "t1", nested: { deeper: { client_secret: "s1" } } } },
      headers: { Authorization: "Bearer x", Cookie: "sid=1", "X-Api-Key": "k1", "set-cookie": "a" },
      oauth: { access_token: "a1", refresh_token: "r1", id_token: "i1" },
      webhookSecret: "w1",
      privateKey: "p1",
      private_key: "p2",
      password: "pw",
    };
    const out = JSON.stringify(redactValue(input));
    for (const secret of [
      "t1",
      "s1",
      "Bearer x",
      "sid=1",
      "k1",
      "a1",
      "r1",
      "i1",
      "w1",
      "p1",
      "p2",
      "pw",
    ]) {
      expect(out).not.toContain(`"${secret}"`);
    }
    expect(out).toContain('"attemptId":"att_1"');
  });

  it("scrubs secrets inside string values of harmless keys", () => {
    const out = redactValue({ message: `push failed with ${GITHUB_TOKENS[0] ?? ""}`, count: 3 });
    expect(out).toEqual({ message: `push failed with ${REDACTED}`, count: 3 });
  });

  it("scrubs arrays", () => {
    expect(redactValue(["ok", `jwt ${JWT}`])).toEqual(["ok", `jwt ${REDACTED}`]);
  });

  it("turns errors into plain objects with scrubbed message and stack, dropping other fields", () => {
    const error = Object.assign(new Error(`request with ${GITHUB_TOKENS[3] ?? ""} failed`), {
      code: "E_HTTP",
      response: { headers: { authorization: "Bearer leaked" }, body: "raw customer log" },
    });
    const out = redactValue({ err: error });
    const text = JSON.stringify(out);
    expect(text).not.toContain("ghs_");
    expect(text).not.toContain("leaked");
    expect(text).not.toContain("raw customer log");
    expect(out).toMatchObject({
      err: { type: "Error", message: `request with ${REDACTED} failed`, code: "E_HTTP" },
    });
  });

  it("stops at a fixed depth instead of walking forever", () => {
    let deep: Record<string, unknown> = { leaf: "value" };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(JSON.stringify(redactValue(deep))).toContain("[truncated]");
  });

  it("handles circular references", () => {
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    expect(redactValue(loop)).toEqual({ name: "loop", self: "[circular]" });
  });

  it("leaves non-plain objects for serializers to handle", () => {
    const date = new Date("2026-09-27T00:00:00Z");
    expect(redactValue({ at: date })).toStrictEqual({ at: date });
  });

  it("passes through primitives", () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue(null)).toBeNull();
    expect(redactValue(undefined)).toBeUndefined();
    expect(redactValue(true)).toBe(true);
  });
});
