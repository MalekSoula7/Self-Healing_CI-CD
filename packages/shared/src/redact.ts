// Secret redaction for anything we log or store (CLAUDE.md: never log secrets, tokens or raw
// customer logs). Two layers:
// - redactText: scrubs secrets that appear inside free text (tokens, keys, JWTs, credentials in URLs).
// - redactValue: walks plain objects, hiding values under secret-looking keys and scrubbing strings.
// This is the shared baseline; the CI-log redactor in agent-core (SPEC §6.2) builds on it.

export const REDACTED = "[redacted]";

const MAX_DEPTH = 8;

// Whole matches replaced by REDACTED. Order matters: PEM blocks first (they contain base64 runs).
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
];

// user:password@ in any URL scheme; the host stays readable.
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]*@/gi;

// Query parameters that carry secrets (OAuth codes, pre-signed URL signatures, tokens).
const SECRET_QUERY_PARAMS =
  /([?&](?:sig|signature|token|access_token|refresh_token|id_token|code|client_secret|jwt|key|api_key|apikey|secret|password|x-amz-signature|x-amz-credential|x-amz-security-token)=)[^&\s"'#]+/gi;

// "Bearer <value>" / "token <value>" in headers or messages.
const AUTH_SCHEMES = /\b(bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi;

// Keys whose values are always hidden, whatever the value looks like.
const SECRET_KEY =
  /(authorization|cookie|api[-_]?key|token|secret|password|passwd|private[-_]?key|credential|signature|jwt)/i;

export function redactText(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replace(SECRET_QUERY_PARAMS, `$1${REDACTED}`)
    .replace(AUTH_SCHEMES, `$1 ${REDACTED}`);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redactError(error: Error): Record<string, unknown> {
  const out: Record<string, unknown> = { type: error.name, message: redactText(error.message) };
  const code: unknown = "code" in error ? error.code : undefined;
  if (typeof code === "string" || typeof code === "number") out.code = code;
  if (error.stack !== undefined) out.stack = redactText(error.stack);
  return out;
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactText(value);
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof Error) return redactError(value);
  if (!Array.isArray(value) && !isPlainObject(value)) return value; // left to log serializers
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[truncated]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : walk(item, depth + 1, seen);
  }
  return out;
}

/**
 * Returns a copy with secret-keyed values hidden and secrets inside strings scrubbed.
 * Errors become `{ type, message, code?, stack? }` (other fields, like HTTP responses, are dropped).
 * Non-plain objects (class instances, dates, buffers) are returned as-is for serializers to handle.
 */
export function redactValue(value: unknown): unknown {
  return walk(value, 0, new WeakSet());
}
