import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "./webhooks";

// The example from GitHub's "Validating webhook deliveries" documentation.
const DOC_SECRET = "It's a Secret to Everybody";
const DOC_PAYLOAD = "Hello, World!";
const DOC_SIGNATURE = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

function sign(secret: string, body: string | Uint8Array): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("verifyWebhookSignature", () => {
  it("accepts GitHub's documented example", () => {
    expect(verifyWebhookSignature(DOC_SECRET, DOC_PAYLOAD, DOC_SIGNATURE)).toBe(true);
    expect(
      verifyWebhookSignature(
        DOC_SECRET,
        DOC_PAYLOAD,
        DOC_SIGNATURE.toUpperCase().replace("SHA256", "sha256"),
      ),
    ).toBe(true);
  });

  it("accepts the raw bytes it was computed over", () => {
    const body = Buffer.from('{"action":"created","emoji":"🔧"}');
    expect(verifyWebhookSignature("s".repeat(32), body, sign("s".repeat(32), body))).toBe(true);
  });

  it.each([
    ["a different body", DOC_SECRET, `${DOC_PAYLOAD} `, DOC_SIGNATURE],
    ["a different secret", "another secret", DOC_PAYLOAD, DOC_SIGNATURE],
    ["no header", DOC_SECRET, DOC_PAYLOAD, null],
    ["an empty header", DOC_SECRET, DOC_PAYLOAD, ""],
    [
      "the SHA-1 header format",
      DOC_SECRET,
      DOC_PAYLOAD,
      "sha1=757107ea0eb2509fc211221cce984b8a37570b6d",
    ],
    ["a truncated signature", DOC_SECRET, DOC_PAYLOAD, DOC_SIGNATURE.slice(0, -2)],
    ["non-hex characters", DOC_SECRET, DOC_PAYLOAD, `sha256=${"z".repeat(64)}`],
    ["an empty secret", "", DOC_PAYLOAD, sign("", DOC_PAYLOAD)],
  ])("rejects %s", (_label, secret, body, header) => {
    expect(verifyWebhookSignature(secret, body, header)).toBe(false);
  });

  it("rejects a JSON body that was re-serialized", () => {
    const raw = '{"b":1, "a":2}';
    const header = sign(DOC_SECRET, raw);
    const reserialized = JSON.stringify(JSON.parse(raw) as unknown);
    expect(verifyWebhookSignature(DOC_SECRET, reserialized, header)).toBe(false);
  });
});
