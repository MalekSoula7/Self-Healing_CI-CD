// Runner sessions (SPEC §5.4). The gateway knows only what a runner sent (an attempt ID) and
// what GitHub signed (the OIDC token's repository and owner IDs). These helpers find an attempt
// only through both, so a runner of one repository can never reach another tenant's attempt,
// and they open an attempt's one session atomically: a second exchange always fails.
import { z } from "zod";
import { auditTarget, writeAudit, type Actor } from "./audit";
import type { Db } from "./client";
import { githubIdSchema } from "./inputs";

/** How long a session lasts (SPEC §5.4). */
export const SESSION_TTL_MS = 45 * 60 * 1000;
/** How long a dispatched attempt waits for its runner (SPEC §2.2). */
export const DISPATCH_TIMEOUT_MS = 15 * 60 * 1000;

const sessionRefSchema = z.strictObject({
  attemptId: z.uuid(),
  /** `repository_id` and `repository_owner_id` from a verified OIDC token. */
  githubRepoId: githubIdSchema,
  githubOwnerId: githubIdSchema,
});
export type SessionRef = z.input<typeof sessionRefSchema>;

const openSchema = z.strictObject({
  /** SHA-256 (hex) of the session token. */
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  now: z.date(),
  /** How long the session lasts: at most SESSION_TTL_MS, less when the attempt's budget is. */
  ttlMs: z.int().min(60_000).max(SESSION_TTL_MS).default(SESSION_TTL_MS),
});

const contestSchema = z.strictObject({
  now: z.date(),
  reason: z.string().min(1).max(200),
});

const ATTEMPT_FOR_SESSION = {
  id: true,
  orgId: true,
  status: true,
  targetSha: true,
  failingCheck: true,
  dispatchRunId: true,
  dispatchedAt: true,
  sessionTokenHash: true,
  org: { select: { status: true } },
  failure: {
    select: {
      repo: {
        select: {
          id: true,
          fullName: true,
          defaultBranch: true,
          enabled: true,
          removedFromInstallationAt: true,
          commands: true,
          junitGlob: true,
        },
      },
    },
  },
} as const;

/** `component` names the caller in the audit log (e.g. "gateway"). */
export function runnerSessions(db: Db, component: string) {
  const actor: Actor = { type: "SYSTEM", component };

  /** The where clause tying an attempt to the repository and owner GitHub signed for. */
  function signedAttempt(ref: z.output<typeof sessionRefSchema>) {
    return {
      id: ref.attemptId,
      failure: {
        repo: { githubRepoId: ref.githubRepoId, org: { githubAccountId: ref.githubOwnerId } },
      },
    };
  }

  return {
    /**
     * The attempt, its repository and its org's status, or null when the attempt doesn't exist
     * or belongs to another repository than the one GitHub signed for (the caller can't tell).
     */
    async find(ref: SessionRef) {
      const parsed = sessionRefSchema.safeParse(ref);
      if (!parsed.success) return null;
      return db.healAttempt.findFirst({
        where: signedAttempt(parsed.data),
        select: ATTEMPT_FOR_SESSION,
      });
    },

    /**
     * Opens the attempt's one session: only while it is DISPATCHED with its run recorded, within
     * the dispatch timeout, without a session, and while its org is active and its repository
     * enabled (re-checked here, atomically). Returns the expiry, or null when another exchange got
     * there first (or the attempt no longer qualifies).
     */
    async open(ref: SessionRef, session: z.input<typeof openSchema>) {
      const parsedRef = sessionRefSchema.parse(ref);
      const { tokenHash, now, ttlMs } = openSchema.parse(session);
      const expiresAt = new Date(now.getTime() + ttlMs);
      return db.$transaction(async (tx) => {
        const attempt = await tx.healAttempt.findFirst({
          where: signedAttempt(parsedRef),
          select: { id: true, orgId: true },
        });
        if (attempt === null) return null;
        const { count } = await tx.healAttempt.updateMany({
          where: {
            id: attempt.id,
            orgId: attempt.orgId,
            status: "DISPATCHED",
            sessionTokenHash: null,
            dispatchRunId: { not: null },
            dispatchedAt: { gt: new Date(now.getTime() - DISPATCH_TIMEOUT_MS) },
            org: { status: "ACTIVE" },
            failure: { repo: { enabled: true, removedFromInstallationAt: null } },
          },
          data: {
            status: "RUNNING",
            sessionTokenHash: tokenHash,
            sessionOpenedAt: now,
            sessionExpiresAt: expiresAt,
          },
        });
        if (count === 0) return null;
        await writeAudit(tx, attempt.orgId, actor, {
          action: "attempt.session_opened",
          target: auditTarget("attempt", attempt.id),
          metadata: { expiresAt: expiresAt.toISOString() },
        });
        return { attemptId: attempt.id, orgId: attempt.orgId, expiresAt };
      });
    },

    /**
     * A token from the attempt's own dispatched run asked for a session the attempt already has.
     * heal-action exchanges once, so something else in that job (a setup step, code under test)
     * got there first or is trying now. The attempt fails and its session is revoked, so neither
     * party keeps it. Returns whether a running attempt was stopped.
     */
    async contest(ref: SessionRef, input: z.input<typeof contestSchema>) {
      const parsedRef = sessionRefSchema.parse(ref);
      const { now, reason } = contestSchema.parse(input);
      return db.$transaction(async (tx) => {
        const attempt = await tx.healAttempt.findFirst({
          where: signedAttempt(parsedRef),
          select: { id: true, orgId: true },
        });
        if (attempt === null) return false;
        const { count } = await tx.healAttempt.updateMany({
          where: { id: attempt.id, orgId: attempt.orgId, status: "RUNNING" },
          data: {
            status: "FAILED",
            sessionTokenHash: null,
            sessionExpiresAt: now,
            finishedAt: now,
          },
        });
        if (count === 0) return false;
        await writeAudit(tx, attempt.orgId, actor, {
          action: "attempt.session_contested",
          target: auditTarget("attempt", attempt.id),
          metadata: { reason },
        });
        return true;
      });
    },
  };
}

export type RunnerSessions = ReturnType<typeof runnerSessions>;
export type AttemptForSession = NonNullable<Awaited<ReturnType<RunnerSessions["find"]>>>;
