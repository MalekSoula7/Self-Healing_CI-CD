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
