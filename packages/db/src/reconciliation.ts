// The database side of the §2.2 reconciler (P5.3b). `reconciliation(db).due` is the one listing
// that crosses organizations, so it returns only IDs and times; everything the reconciler then
// reads or changes goes through the organization's system scope (`attemptRecovery` is part of its
// `attempts`).
import { auditTarget, writeAudit, type Actor } from "./audit";
import type { Db } from "./client";
import { NotFoundError } from "./errors";
import type { AttemptStatus, FailureStatus } from "./generated/prisma/enums";
import { idSchema } from "./inputs";
import { endedFailureStatus } from "./retries";
import { DISPATCH_TIMEOUT_MS } from "./runner-sessions";

const minutes = (count: number) => count * 60_000;

/** How long a state is left alone before the reconciler looks at it (SPEC §2.2). */
export const RECONCILE_AFTER_MS = {
  /** A validation or publish job may be lost. */
  submission: minutes(10),
  /** No publish job runs this long: the outcome has to be read from GitHub. */
  publishing: minutes(15),
  /** CI's webhook may have been missed. */
  openPullRequest: minutes(10),
  /** A flaky re-run that never reports. */
  rerun: minutes(6 * 60),
} as const;

/** Attempts a runner is still expected to move on. */
const WITH_RUNNER: AttemptStatus[] = ["DISPATCHED", "RUNNING", "AWAITING_SUBMISSION"];

/** What a failure becomes when its newest attempt ended this way and left it HEALING. */
const ENDED: Partial<Record<AttemptStatus, FailureStatus>> = {
  GAVE_UP: "NEEDS_HUMAN",
  NOT_REPRODUCIBLE: "NOT_REPRODUCIBLE",
  REJECTED: "FAILED",
  FAILED: "FAILED",
};

export function reconciliation(db: Db) {
  return {
    /** What has been waiting too long, oldest first, at most `limit` of each kind. */
    async due(now: Date, limit = 100) {
      const before = (ms: number) => new Date(now.getTime() - ms);
      const ids = { id: true, orgId: true, updatedAt: true } as const;
      const oldest = { orderBy: { updatedAt: "asc" }, take: limit } as const;
      const [expired, submissions, publishing, opened, unsettled, reruns] = await Promise.all([
        db.healAttempt.findMany({
          where: {
            OR: [
              {
                status: "DISPATCHED",
                sessionOpenedAt: null,
                dispatchedAt: { lte: before(DISPATCH_TIMEOUT_MS) },
              },
              { status: { in: WITH_RUNNER }, sessionExpiresAt: { lte: now } },
            ],
          },
          select: ids,
          ...oldest,
        }),
        db.healAttempt.findMany({
          where: {
            status: { in: ["VALIDATING", "VALIDATED"] },
            updatedAt: { lte: before(RECONCILE_AFTER_MS.submission) },
          },
          select: { ...ids, status: true },
          ...oldest,
        }),
        db.healAttempt.findMany({
          where: {
            status: "PUBLISHING",
            updatedAt: { lte: before(RECONCILE_AFTER_MS.publishing) },
          },
          select: ids,
          ...oldest,
        }),
        db.healAttempt.findMany({
          where: {
            status: "PR_OPENED",
            prOpenedAt: { lte: before(RECONCILE_AFTER_MS.openPullRequest) },
          },
          select: { ...ids, prOpenedAt: true },
          orderBy: { prOpenedAt: "asc" },
          take: limit,
        }),
        db.healAttempt.findMany({
          where: {
            status: { in: Object.keys(ENDED) as AttemptStatus[] },
            failure: { status: "HEALING" },
          },
          select: ids,
          ...oldest,
        }),
        db.failedRun.findMany({
          where: {
            rerunByUs: true,
            // Not reported yet. In the query, so reported ones never fill the page.
            rerunFromAttempt: { equals: db.failedRun.fields.runAttempt },
            updatedAt: { lte: before(RECONCILE_AFTER_MS.rerun) },
            failure: { status: "TRIAGED" },
          },
          select: { orgId: true, failureId: true },
          ...oldest,
        }),
      ]);
      const ref = (row: { id: string; orgId: string; updatedAt: Date }) => ({
        orgId: row.orgId,
        attemptId: row.id,
        since: row.updatedAt,
      });
      return {
        expired: expired.map(ref),
        submissions: submissions.map((row) => ({ ...ref(row), status: row.status })),
        publishing: publishing.map(ref),
        opened: opened.map((row) => ({ ...ref(row), since: row.prOpenedAt ?? row.updatedAt })),
        unsettled: unsettled.map(ref),
        reruns,
      };
    },
  };
}

export type Reconciliation = ReturnType<typeof reconciliation>;

export function attemptRecovery(db: Db, orgId: string, actor: Actor) {
  const requireId = (value: string) => {
    const parsed = idSchema.safeParse(value);
    if (!parsed.success) throw new NotFoundError("attempt not found");
    return parsed.data;
  };

  return {
    /**
     * Fails an attempt whose healer never started, or whose session ran out before it finished,
     * and revokes the session. Compare-and-set: null when the attempt moved on, or isn't late.
     */
    async expire(attemptId: string, now: Date) {
      const id = requireId(attemptId);
      return db.$transaction(async (tx) => {
        const attempt = await tx.healAttempt.findFirst({ where: { id, orgId } });
        if (attempt === null) throw new NotFoundError("attempt not found");
        if (!WITH_RUNNER.includes(attempt.status)) return null;
        const neverStarted =
          attempt.status === "DISPATCHED" &&
          attempt.sessionOpenedAt === null &&
          attempt.dispatchedAt.getTime() <= now.getTime() - DISPATCH_TIMEOUT_MS;
        const ranOut = attempt.sessionExpiresAt !== null && attempt.sessionExpiresAt <= now;
        if (!neverStarted && !ranOut) return null;
        const reason = neverStarted
          ? "the healer never started"
          : "the healer's session ended before it finished";
        const { count } = await tx.healAttempt.updateMany({
          // Unchanged since it was read: a step that just arrived wins.
          where: { id, orgId, status: attempt.status, updatedAt: attempt.updatedAt },
          data: { status: "FAILED", endReason: reason, finishedAt: now, sessionTokenHash: null },
        });
        if (count === 0) return null;
        const newer = await tx.healAttempt.count({
          where: { orgId, failureId: attempt.failureId, attemptNo: { gt: attempt.attemptNo } },
        });
        if (newer === 0) {
          await tx.pipelineFailure.updateMany({
            where: { id: attempt.failureId, orgId, status: "HEALING" },
            data: { status: endedFailureStatus(attempt, "FAILED") },
          });
        }
        await writeAudit(tx, orgId, actor, {
          action: "attempt.expired",
          target: auditTarget("attempt", id),
          metadata: { from: attempt.status, reason },
        });
        return reason;
      });
    },

    /**
     * Moves a failure out of HEALING when its newest attempt has ended without a pull request.
     * Returns whether it moved.
     */
    async settleFailure(attemptId: string) {
      const id = requireId(attemptId);
      return db.$transaction(async (tx) => {
        const attempt = await tx.healAttempt.findFirst({ where: { id, orgId } });
        if (attempt === null) throw new NotFoundError("attempt not found");
        const ended = ENDED[attempt.status];
        if (ended === undefined) return false;
        const status = endedFailureStatus(attempt, ended);
        const newer = await tx.healAttempt.count({
          where: { orgId, failureId: attempt.failureId, attemptNo: { gt: attempt.attemptNo } },
        });
        if (newer > 0) return false;
        const { count } = await tx.pipelineFailure.updateMany({
          where: { id: attempt.failureId, orgId, status: "HEALING" },
          data: { status },
        });
        if (count === 0) return false;
        await writeAudit(tx, orgId, actor, {
          action: "failure.settled",
          target: auditTarget("failure", attempt.failureId),
          metadata: { status, attemptId: id },
        });
        return true;
      });
    },
  };
}
