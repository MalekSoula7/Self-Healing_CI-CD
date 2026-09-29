// SPEC §6.2 step 3: fixture tests with planted fake secrets are mandatory. The fakes are generated
// here (seeded, so a failure reproduces) rather than committed: nothing secret-shaped is in git.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanLog } from "../logs/clean";
import { redactLog, type RedactionKind } from "./redact";

function fixture(name: string): string {
  return readFileSync(new URL(`../../fixtures/secrets/${name}`, import.meta.url), "utf8");
}

/** mulberry32: a tiny seeded PRNG, so the fake secrets are the same on every run. */
function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const BASE64 = `${ALNUM}+/`;
const BASE64URL = `${ALNUM}-_`;

const random = prng(20260929);
function fake(alphabet: string, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet.charAt(Math.floor(random() * alphabet.length));
  return out;
}

const SECRETS = {
  githubInstallationToken: "gh" + "s_" + fake(ALNUM, 36),
  githubPat: "github" + "_pat_" + fake(ALNUM, 22) + "_" + fake(ALNUM, 59),
  npmToken: "np" + "m_" + fake(ALNUM, 36),
  awsAccessKeyId: "AK" + "IA" + fake(UPPER_DIGITS, 16),
  awsSecretAccessKey: fake(BASE64, 40),
  dbPassword: "Tr0ub4dor-" + fake(ALNUM, 14),
  sqlPassword: fake(ALNUM, 22),
  bearerToken: fake(BASE64URL, 30) + "9" + fake(BASE64URL, 9),
  jsonApiKey: fake(ALNUM, 32),
  clientSecret: fake(ALNUM, 40),
  jwt: "ey" + "J" + fake(BASE64URL, 34) + ".eyJ" + fake(BASE64URL, 60) + "." + fake(BASE64URL, 43),
  anthropicKey: "sk-" + "ant-api03-" + fake(BASE64URL, 80),
  highEntropy: fake(BASE64, 44),
  privateKeyLine1: fake(BASE64, 70),
  privateKeyLine2: fake(BASE64, 70),
};

function plantedLog(): string {
  let text = fixture("job-log.template.txt").replaceAll("{{ESC}}", "\u001b");
  for (const [name, value] of Object.entries(SECRETS)) text = text.replaceAll(`{{${name}}}`, value);
  expect(text).not.toMatch(/\{\{\w+\}\}/);
  return text;
}

/** Every 12-character slice of the secret: a partial leak is still a leak. */
function slices(secret: string): string[] {
  if (secret.length <= 12) return [secret];
  return Array.from({ length: secret.length - 11 }, (_, i) => secret.slice(i, i + 12));
}

describe("redactLog on a CI log with planted secrets of every SPEC §6.2 type", () => {
  const { text, redactions } = redactLog(cleanLog(plantedLog()));

  it.each(Object.entries(SECRETS))(
    "removes %s entirely, not even a 12-character slice left",
    (_, secret) => {
      for (const slice of slices(secret)) expect(text).not.toContain(slice);
    },
  );

  it("records what kinds it redacted", () => {
    const kinds: RedactionKind[] = [
      "private-key",
      "github-token",
      "api-key",
      "aws-access-key",
      "jwt",
      "url-credentials",
      "authorization",
      "assignment",
      "high-entropy",
    ];
    expect(Object.keys(redactions)).toEqual(expect.arrayContaining(kinds));
  });

  it("keeps what triage needs: errors, exit codes, commit SHAs, hosts, harmless config", () => {
    for (const kept of [
      "src/receipt.ts:1:25 - error TS2305: Module '\"./cart\"' has no exported member 'lineTotal'.",
      "##[error]Process completed with exit code 2.",
      "72a7d40e3f1c9b8a6d5e4f3a2b1c0d9e8f7a6b5c",
      "@github.com/acme/checkout",
      "@db.internal:5432/checkout",
      "https://api.example.com/v1/rates",
      '"region": "eu-west-1", "retries": 3',
      "added 130 packages, and audited 131 packages in 3s",
      "export GITHUB_TOKEN=",
      "Deploy key:",
    ]) {
      expect(text).toContain(kept);
    }
  });

  it("marks each redaction with its kind, so triage can still tell what was there", () => {
    expect(text).toContain(
      "https://x-access-token:[redacted:url-credentials]@github.com/acme/checkout",
    );
    expect(text).toContain("Authorization: Bearer [redacted:authorization]");
    expect(text).toContain('"apiKey": "[redacted:assignment]"');
    expect(text).toMatch(/Deploy key:\n\[redacted:private-key\]\n/);
  });

  it("is idempotent", () => {
    expect(redactLog(text).text).toBe(text);
  });
});

describe("redactLog on a CI log without secrets", () => {
  it("changes nothing: test names, error messages, hashes, UUIDs, paths and URLs stay", () => {
    const text = fixture("no-secrets.txt");

    const result = redactLog(text);

    expect(result.text).toBe(text);
    expect(result.redactions).toEqual({});
  });
});

describe("redactLog rules", () => {
  it.each<[RedactionKind, string, string]>([
    [
      "github-token",
      `push with ${"gh" + "p_"}${"a1B2".repeat(9)} now`,
      "push with [redacted:github-token] now",
    ],
    ["github-token", `ghu ${"gh" + "u_"}${"Z9y8".repeat(9)}`, "ghu [redacted:github-token]"],
    [
      "aws-access-key",
      `id ${"AS" + "IA"}ABCDEFGHIJ123456 used`,
      "id [redacted:aws-access-key] used",
    ],
    ["api-key", `key ${"sk-" + "proj-"}${"Ab3_".repeat(10)}`, "key [redacted:api-key]"],
    [
      "api-key",
      `slack ${"xox" + "b-"}123456789012-123456789012-${"aB3d".repeat(6)}`,
      "slack [redacted:api-key]",
    ],
    ["api-key", `stripe ${"sk" + "_live_"}${"aB3d".repeat(6)}`, "stripe [redacted:api-key]"],
    ["api-key", `google ${"AI" + "za"}${"Sy3d_Ab-9".repeat(4)}`, "google [redacted:api-key]"],
    [
      "url-credentials",
      "redis://default:hunter2hunter2@cache:6379/0",
      "redis://default:[redacted:url-credentials]@cache:6379/0",
    ],
    [
      "url-credentials",
      `git clone https://${"a1B2c3D4".repeat(3)}@github.com/o/r`,
      "git clone https://[redacted:url-credentials]@github.com/o/r",
    ],
    [
      "authorization",
      "authorization: Basic dXNlcjpwYXNzd29yZDEyMw==",
      "authorization: Basic [redacted:authorization]",
    ],
    [
      "authorization",
      "Authorization: 0a1b2c3d4e5f6a7b8c9d",
      "Authorization: [redacted:authorization]",
    ],
    [
      "authorization",
      "retrying with Bearer 0a1b2c3d4e5f6g7h8i9j",
      "retrying with Bearer [redacted:authorization]",
    ],
    [
      "assignment",
      "export DEPLOY_SECRET='s3cr3t value here'",
      "export DEPLOY_SECRET='[redacted:assignment]'",
    ],
    ["assignment", "--password=correct-horse-battery", "--password=[redacted:assignment]"],
    ["assignment", "db_passwd: hunter2", "db_passwd: [redacted:assignment]"],
    ["assignment", "API_KEY=abc123;next", "API_KEY=[redacted:assignment];next"],
  ])("%s: %s", (kind, input, expected) => {
    const result = redactLog(input);
    expect(result.text).toBe(expected);
    expect(result.redactions[kind]).toBe(1);
  });

  it("still catches what only the shared backstop knows, such as a pre-signed URL's signature", () => {
    const result = redactLog(
      "GET https://bucket.s3.amazonaws.com/f.tgz?X-Amz-Signature=0f1e2d3c4b5a69788796a5b4&X-Amz-Date=20260929",
    );
    expect(result.text).toBe(
      "GET https://bucket.s3.amazonaws.com/f.tgz?X-Amz-Signature=[redacted]&X-Amz-Date=20260929",
    );
    expect(result.redactions).toEqual({ other: 1 });
  });

  it("redacts a private key block through to the end when the log was cut off inside it", () => {
    const result = redactLog(
      `before\n-----BEGIN RSA PRIVATE KEY-----\nMIIE${"Ab3/".repeat(16)}\nMIIE${"Zz9+".repeat(16)}`,
    );
    expect(result.text).toBe("before\n[redacted:private-key]");
  });

  it("redacts PGP private key blocks", () => {
    const block = `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBF${"Ab3+".repeat(15)}\n-----END PGP PRIVATE KEY BLOCK-----`;
    expect(redactLog(`k\n${block}\nafter`).text).toBe("k\n[redacted:private-key]\nafter");
  });

  it("leaves masked values (***), empty values and ordinary words after 'token' alone", () => {
    const texts = [
      "token: ***",
      "Authorization: ***",
      "PASSWORD=",
      "Unexpected token } in JSON",
      "token validation failed for request",
      "tests/test_token.py::test_refresh PASSED",
      "tokens used: 1234",
    ];
    expect(texts.map((text) => redactLog(text).text)).toEqual(texts);
  });

  it("stays fast on a large log and on pathological input (no catastrophic backtracking)", () => {
    const line = "2026-09-28 INFO request handled in 12ms path=/api/v1/orders status=200\n";
    const big = line.repeat(60_000) + "A".repeat(200_000) + "\n" + "token ".repeat(50_000);

    const started = performance.now();
    redactLog(big);

    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
