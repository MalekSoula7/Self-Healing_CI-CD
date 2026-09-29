// GitHub webhook signatures (SPEC §12): HMAC-SHA256 of the raw request body with the App's
// webhook secret, in the X-Hub-Signature-256 header, compared in constant time.
import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE = /^sha256=([0-9a-f]{64})$/i;

/**
 * True only for a well-formed `sha256=<hex>` signature of exactly `rawBody`. Verify the raw
 * bytes as received: re-serialized JSON would not match.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined,
): boolean {
  if (secret.length === 0) return false;
  const hex = SIGNATURE.exec(signatureHeader ?? "")?.[1];
  if (hex === undefined) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(hex, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
