// The GitHub App's credentials, as they come from the environment. Error messages name the
// problem, never the value.
import { createPrivateKey } from "node:crypto";
import { z } from "zod";

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const PEM =
  /^-----BEGIN (RSA )?PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END (RSA )?PRIVATE KEY-----\n?$/;

export class PrivateKeyError extends Error {
  override readonly name = "PrivateKeyError";
}

/**
 * The App's private key from GITHUB_APP_PRIVATE_KEY: the downloaded .pem file, base64-encoded
 * on one line (no newline-escaping problems across shells and hosting providers).
 * Returns the PEM text. Throws PrivateKeyError if it isn't a usable RSA private key.
 */
export function decodePrivateKey(base64: string): string {
  const compact = base64.replace(/\s+/g, "");
  if (!BASE64.test(compact)) throw new PrivateKeyError("the private key is not base64");
  const pem = Buffer.from(compact, "base64").toString("utf8").replace(/\r\n/g, "\n");
  if (!PEM.test(pem)) {
    throw new PrivateKeyError("the private key is not a base64-encoded PEM private key");
  }
  try {
    if (createPrivateKey(pem).asymmetricKeyType !== "rsa") {
      throw new PrivateKeyError("the private key is not an RSA key");
    }
  } catch (error) {
    if (error instanceof PrivateKeyError) throw error;
    throw new PrivateKeyError("the private key cannot be parsed");
  }
  return pem;
}

/** zod pieces for the apps' env schemas (worker, web webhook route). */
export const githubAppIdSchema = z
  .string()
  .regex(/^\d+$/, "must be the App's numeric ID")
  .transform(Number);

export const githubPrivateKeySchema = z.string().transform((value, ctx) => {
  try {
    return decodePrivateKey(value);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof PrivateKeyError ? error.message : "invalid private key",
    });
    return z.NEVER;
  }
});

export const webhookSecretSchema = z.string().min(32, "must be at least 32 characters");
