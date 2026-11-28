// Verification (SPEC §9.1, P5.3): CI's answer about an attempt's pull request. An attempt is found
// by the commit PipeHeal itself created, never by a branch name, which a fork can copy (P1.4
// review). The helpers are part of the system scope's `attempts`.
import { auditTarget, writeAudit, type Actor } from "./audit";
import type { Db } from "./client";
import { NotFoundError } from "./errors";
import type { AttemptStatus, FailureStatus } from "./generated/prisma/enums";
import { idSchema, verificationSchema, type VerificationInput } from "./inputs";

/** The statuses of an attempt whose pull request is open or has had CI's answer. */
const WITH_PULL_REQUEST: AttemptStatus[] = ["PR_OPENED", "VERIFIED", "CI_FAILED", "UNVERIFIED"];

interface Outcome {
  attempt: AttemptStatus;
  failure: FailureStatus;
  /** The attempt statuses this answer may replace. */
  from: AttemptStatus[];
}

const OUTCOMES: Record<VerificationInput["result"], Outcome> = {
  // CI that reports late, or a re-run that passes, replaces an earlier answer.
  verified: {
    attempt: "VERIFIED",
    failure: "VERIFIED",
    from: ["PR_OPENED", "CI_FAILED", "UNVERIFIED"],
  },
  failed: {
    attempt: "CI_FAILED",
    failure: "NEEDS_HUMAN",
    from: ["PR_OPENED", "VERIFIED", "UNVERIFIED"],
  },
  // Only ever the first answer: silence never overrides what CI said.
  unverified: { attempt: "UNVERIFIED", failure: "UNVERIFIED", from: ["PR_OPENED"] },
};

/** A failure in one of these follows its newest attempt's verification. */
const VERIFYING: FailureStatus[] = ["PR_OPENED", "VERIFIED", "UNVERIFIED", "NEEDS_HUMAN"];

/** What verifying an attempt needs. */
const VERIFIABLE = {
  id: true,
  status: true,
  attemptNo: true,
  failingCheck: true,
  branch: true,
  commitSha: true,
  prNumber: true,
  prOpenedAt: true,
  org: { select: { installationId: true, status: true } },
  failure: {
    select: {
      id: true,
      repo: {
        select: {
          id: true,
          githubRepoId: true,
          fullName: true,
          enabled: true,
          removedFromInstallationAt: true,
        },
      },
      runs: {
        select: {
          workflowId: true,
          conclusion: true,
          jobs: { select: { name: true, failedStep: true } },
        },
      },
    },
  },
} as const;

export function attemptVerification(db: Db, orgId: string, actor: Actor) {
  return {
    /** The same, by the attempt's ID: for the reconciler (§2.2). Null when it isn't this org's. */
    async forVerification(attemptId: string) {
      const id = idSchema.safeParse(attemptId);
      if (!id.success) return null;
      return db.healAttempt.findFirst({ where: { id: id.data, orgId }, select: VERIFIABLE });
    },

    /**
     * The attempt whose pull request carries this commit in this repository, with what verifying
     * it needs; null when PipeHeal didn't create the commit.
     */
    async forCommit(repoId: string, commitSha: string) {
      const repo = idSchema.safeParse(repoId);
      if (!repo.success || !/^[0-9a-f]{40}$/.test(commitSha)) return null;
      return db.healAttempt.findFirst({
        where: {
          orgId,
          commitSha,
          status: { in: WITH_PULL_REQUEST },
          failure: { repoId: repo.data },
        },
        select: VERIFIABLE,
        orderBy: { attemptNo: "desc" },
      });
    },

    /**
     * Records CI's answer for an attempt's pull request. Compare-and-set: `changed` is true for
     * the one call that moved the attempt; `firstFailure` for the one that may tell the PR its
     * fix failed. An answer from older evidence than the attempt has seen changes nothing. The
     * failure follows only its newest attempt.
     */
    async recordVerification(attemptId: string, input: VerificationInput) {
      const id = idSchema.safeParse(attemptId);
      if (!id.success) throw new NotFoundError("attempt not found");
      const data = verificationSchema.parse(input);
      const outcome = OUTCOMES[data.result];
      const { seen } = data;
      const notOlder = seen === undefined ? {} : { ciSeen: { lte: seen } };
      const mark = seen === undefined ? {} : { ciSeen: seen };
      return db.$transaction(async (tx) => {
        const attempt = await tx.healAttempt.findFirst({ where: { id: id.data, orgId } });
        if (attempt === null) throw new NotFoundError("attempt not found");
        const { count } = await tx.healAttempt.updateMany({
          where: { id: attempt.id, orgId, status: { in: outcome.from }, ...notOlder },
          data: {
            status: outcome.attempt,
            endReason: data.reason ?? null,
            finishedAt: new Date(),
            ...mark,
          },
        });
        if (count === 0) {
          // The same answer from newer evidence still raises the mark.
          if (seen !== undefined) {
            await tx.healAttempt.updateMany({
              where: { id: attempt.id, orgId, status: outcome.attempt, ciSeen: { lt: seen } },
              data: mark,
            });
          }
          return { changed: false, firstFailure: false };
        }
        const newer = await tx.healAttempt.count({
          where: { orgId, failureId: attempt.failureId, attemptNo: { gt: attempt.attemptNo } },
        });
        if (newer === 0) {
          await tx.pipelineFailure.updateMany({
            where: { id: attempt.failureId, orgId, status: { in: VERIFYING } },
            data: { status: outcome.failure },
          });
        }
        let firstFailure = false;
        if (data.result === "failed") {
          const first = await tx.healAttempt.updateMany({
            where: { id: attempt.id, orgId, ciFailedAt: null },
            data: { ciFailedAt: new Date() },
          });
          firstFailure = first.count === 1;
        }
        await writeAudit(tx, orgId, actor, {
          action: "attempt.verification",
          target: auditTarget("attempt", attempt.id),
          metadata: { result: data.result, from: attempt.status },
        });
        return { changed: true, firstFailure };
      });
    },
  };
}
