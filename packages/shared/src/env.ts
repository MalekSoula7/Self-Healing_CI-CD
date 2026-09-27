import { z } from "zod";

// Environment validation shared by every app (CLAUDE.md: validate env vars with zod, fail fast).
// Error messages name the offending keys and what is wrong, never the values: env vars hold secrets.

export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface EnvIssue {
  readonly key: string;
  readonly problem: string;
}

export class EnvValidationError extends Error {
  readonly issues: readonly EnvIssue[];

  constructor(issues: readonly EnvIssue[]) {
    const lines = issues.map((issue) => `  - ${issue.key}: ${issue.problem}`);
    super(`Invalid environment (see .env.example):\n${lines.join("\n")}`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }

  get keys(): string[] {
    return [...new Set(this.issues.map((issue) => issue.key))];
  }
}

/** A TCP port given as a decimal string, 1-65535. */
export const envPort = z
  .string()
  .regex(/^\d+$/, "must be a whole number")
  .transform(Number)
  .pipe(z.number().int().min(1).max(65535));

/** An absolute http(s) URL. Plain z.url() also accepts "localhost:3000" (scheme "localhost:"). */
export const envHttpUrl = z.url({ protocol: /^https?$/, error: "must be an http(s) URL" });

/** "true"/"1" or "false"/"0". Anything else is rejected rather than guessed. */
export const envBoolean = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

/**
 * Parses `source` (default: `process.env`) with `schema`.
 * Empty strings count as unset, so `FOO=` in a .env file falls back to the schema default.
 * Throws EnvValidationError listing every problem at once.
 */
export function parseEnv<S extends z.ZodObject>(
  schema: S,
  source: EnvSource = process.env,
): z.output<S> {
  const present = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ""),
  );
  const result = schema.safeParse(present);
  if (result.success) return result.data;

  const issues = result.error.issues
    .map((issue) => ({
      key: typeof issue.path[0] === "string" ? issue.path[0] : "(root)",
      problem: issue.message,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  throw new EnvValidationError(issues);
}

// Names that must never be exposed through NEXT_PUBLIC_ (Next inlines those into browser bundles).
const SECRET_NAME =
  /(SECRET|PRIVATE_KEY|API_KEY|TOKEN|PASSWORD|DSN|CREDENTIAL|SMEE_URL|DATABASE_URL|REDIS_URL)/;

/** NEXT_PUBLIC_* variable names that look like secrets. Checked at build and at server start. */
export function publicSecretNames(source: EnvSource): string[] {
  return Object.keys(source).filter(
    (name) =>
      name.startsWith("NEXT_PUBLIC_") && SECRET_NAME.test(name.slice("NEXT_PUBLIC_".length)),
  );
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** True when `url` uses the secure protocol, or points at a loopback host (local dev, e2e). */
export function secureUnlessLoopback(url: string, secureProtocol: "https:" | "rediss:"): boolean {
  const parsed = new URL(url);
  return parsed.protocol === secureProtocol || LOOPBACK_HOSTS.has(parsed.hostname);
}
