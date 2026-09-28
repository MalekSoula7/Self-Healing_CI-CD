// Per-installation pacing of GitHub calls (P2.1; P1.4 review). octokit's own throttling is off
// because its queue is process-wide: one busy tenant would slow every tenant. Instead each
// installation's quota, as GitHub reports it, is kept in Redis, and that installation's jobs wait
// for the reset once it runs low or GitHub rate-limits it. Other installations are unaffected.
import type { RateLimitState } from "@pipeheal/github";
import type { Logger } from "@pipeheal/shared/logger";
import type { Redis } from "ioredis";
import { z } from "zod";

/**
 * Below this many requests left, an installation's jobs wait for its quota to reset: headroom
 * for jobs already running (a job makes a handful of calls; installation syncs make more).
 */
export const RATE_LIMIT_RESERVE = 200;

export interface InstallationPacing {
  /** Records the quota GitHub just reported. Fire and forget: never throws, never waits. */
  record(installationId: bigint, state: RateLimitState): void;
  /** GitHub rate-limited the installation: its jobs wait until `until`. */
  pause(installationId: bigint, until: Date): Promise<void>;
  /** When the installation's jobs may run again, or null if they may run now. */
  pausedUntil(installationId: bigint): Promise<Date | null>;
}

const stateSchema = z.object({ remaining: z.number(), resetAt: z.iso.datetime() });

export function redisPacing(
  redis: Redis,
  logger: Logger,
  prefix = "pipeheal:ratelimit:",
): InstallationPacing {
  const key = (installationId: bigint) => `${prefix}${String(installationId)}`;
  const save = (installationId: bigint, state: RateLimitState) =>
    // Expires when the quota resets: no stale pause survives it.
    redis.set(
      key(installationId),
      JSON.stringify({ remaining: state.remaining, resetAt: state.resetAt.toISOString() }),
      "PXAT",
      Math.max(state.resetAt.getTime(), Date.now() + 1_000),
    );

  return {
    record(installationId, state) {
      save(installationId, state).catch((error: unknown) => {
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "couldn't record GitHub rate limit",
        );
      });
    },
    async pause(installationId, until) {
      await save(installationId, { remaining: 0, resetAt: until });
    },
    async pausedUntil(installationId) {
      const raw = await redis.get(key(installationId));
      if (raw === null) return null;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        return null;
      }
      const parsed = stateSchema.safeParse(value);
      if (!parsed.success) return null;
      const resetAt = new Date(parsed.data.resetAt);
      return parsed.data.remaining < RATE_LIMIT_RESERVE && resetAt.getTime() > Date.now()
        ? resetAt
        : null;
    },
  };
}

/** Thrown to delay a job until its installation may call GitHub again. Not a failure. */
export class RateLimitedError extends Error {
  override readonly name = "RateLimitedError";

  constructor(readonly until: Date) {
    super(`GitHub rate limit: waiting until ${until.toISOString()}`);
  }
}
