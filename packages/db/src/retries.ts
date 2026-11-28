// The retry after failed CI (SPEC §9.1, P5.3d): a new attempt on PipeHeal's own commit, claimed
// under the same caps as the first, with what CI said as its evidence. Its fix is judged together
// with the earlier ones against the original commit (`chain`), and when it ends without a commit
// the failure goes to a person: the pull request is already open. The helpers are part of the
// system scope's `attempts`.
import { auditTarget, writeAudit, type Actor } from "./audit";
import type { Db } from "./client";
import { NotFoundError } from "./errors";
import { Prisma } from "./generated/prisma/client";
import type { FailureStatus } from "./generated/prisma/enums";
import { idSchema, retryClaimSchema, type RetryClaimInput } from "./inputs";
import { DISPATCH_TIMEOUT_MS } from "./runner-sessions";
import { retrySerialization } from "./serialization";

/** How long an attempt being validated or published holds its repository (P5.2 review M4). */
const SETTLING_TIMEOUT_MS = 2 * 60 * 60_000;

/** The status of a failure whose attempt ended without a commit. */
export function endedFailureStatus(
  attempt: { retryOfId: string | null },
  otherwise: FailureStatus,
): FailureStatus {
  return attempt.retryOfId === null ? otherwise : "NEEDS_HUMAN";
}

/**
 * Attempts in flight in a repository: dispatched and still within the dispatch timeout, with a
 * session that hasn't expired, or being checked or published. Each is bounded, so a stuck one
 * can't hold the repository for good (P4.8 review M2).
 */
export function inFlightIn(
  orgId: string,
  repoId: string,
  now: number,
): Prisma.HealAttemptWhereInput {
  return {
    orgId,
    failure: { repoId },
    OR: [
      {
        status: "DISPATCHED",
        sessionOpenedAt: null,
        dispatchedAt: { gt: new Date(now - DISPATCH_TIMEOUT_MS) },
      },
      {
        status: { in: ["DISPATCHED", "RUNNING", "AWAITING_SUBMISSION"] },
        sessionExpiresAt: { gt: new Date(now) },
      },
      {
        status: { in: ["VALIDATING", "VALIDATED", "PUBLISHING"] },
        updatedAt: { gt: new Date(now - SETTLING_TIMEOUT_MS) },
      },
    ],
  };
}

/** The most attempts one chain is followed through (the policy's cap is far lower). */
const MAX_CHAIN = 20;

export function attemptRetries(db: Db, orgId: string, actor: Actor) {
  return {
    /**
     * The next attempt after one whose CI failed. In one serializable transaction: that attempt
     * must be CI_FAILED and its failure's newest, the failure NEEDS_HUMAN, the org and repository
     * enabled, nothing else in flight, and both caps not reached. Then the failure is HEALING.
     */
    async claimRetry(input: RetryClaimInput) {
      const data = retryClaimSchema.parse(input);
      return retrySerialization(() =>
        db.$transaction(
          async (tx) => {
            const previous = await tx.healAttempt.findFirst({
              where: { id: data.previousAttemptId, orgId },
              include: {
                org: { select: { status: true } },
                failure: { include: { repo: true } },
              },
            });
            if (previous === null) throw new NotFoundError("attempt not found");
            const { failure } = previous;
            const { repo } = failure;
            const count = await tx.healAttempt.count({ where: { orgId, failureId: failure.id } });
            if (
              previous.status !== "CI_FAILED" ||
              previous.commitSha === null ||
              previous.branch === null ||
              previous.prNumber === null ||
              previous.attemptNo !== count ||
              failure.status !== "NEEDS_HUMAN" ||
              previous.org.status !== "ACTIVE" ||
              !repo.enabled ||
              repo.removedFromInstallationAt !== null
            ) {
              return { outcome: "not_ready" as const };
            }
            const busy = await tx.healAttempt.count({
              where: inFlightIn(orgId, repo.id, Date.now()),
            });
            if (busy > 0) return { outcome: "busy" as const };
            if (count >= data.maxAttemptsPerFailure) {
              return { outcome: "capped" as const, reason: "the failure's attempt cap is reached" };
            }
            const today = await tx.healAttempt.count({
              where: { orgId, createdAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) } },
            });
            if (today >= data.maxAttemptsPerDay) {
              return {
                outcome: "capped" as const,
                reason: "the organization's daily attempt cap is reached",
              };
            }
            const attempt = await tx.healAttempt.create({
              data: {
                orgId,
                failureId: failure.id,
                attemptNo: count + 1,
                targetSha: previous.commitSha,
                failingCheck: data.failingCheck,
                retryOfId: previous.id,
                feedback: data.feedback,
              },
            });
            await tx.pipelineFailure.update({
              where: { id: failure.id },
              data: { status: "HEALING" },
            });
            await writeAudit(tx, orgId, actor, {
              action: "attempt.retried",
              target: auditTarget("attempt", attempt.id),
              metadata: {
                failureId: failure.id,
                attemptNo: attempt.attemptNo,
                retryOf: previous.id,
              },
            });
            return { outcome: "created" as const, attempt };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      );
    },

    /**
     * What a retry builds on: the commit the first attempt healed, that attempt's baseline tests,
     * every earlier attempt's uploaded files (oldest first), and the attempt it follows. Null for
     * an attempt that retries nothing, or when any of it is missing: it then can't be checked.
     */
    async chain(attemptId: string) {
      const parsed = idSchema.safeParse(attemptId);
      if (!parsed.success) return null;
      const select = {
        id: true,
        retryOfId: true,
        status: true,
        targetSha: true,
        baselineTests: true,
        branch: true,
        commitSha: true,
        prNumber: true,
        submission: { select: { files: true } },
      } as const;
      const find = (id: string) => db.healAttempt.findFirst({ where: { id, orgId }, select });
      const current = await find(parsed.data);
      if (current?.retryOfId == null) return null;
      const earlier: NonNullable<Awaited<ReturnType<typeof find>>>[] = [];
      let next: string | null = current.retryOfId;
      while (next !== null && earlier.length < MAX_CHAIN) {
        const found: Awaited<ReturnType<typeof find>> = await find(next);
        if (found?.submission == null) return null;
        earlier.unshift(found);
        next = found.retryOfId;
      }
      const first = earlier[0];
      const previous = earlier.at(-1);
      if (next !== null || first === undefined || previous === undefined) return null;
      return {
        originalSha: first.targetSha,
        baselineTests: first.baselineTests,
        earlierFiles: earlier.map((attempt) => attempt.submission?.files ?? null),
        previous: {
          id: previous.id,
          status: previous.status,
          branch: previous.branch,
          commitSha: previous.commitSha,
          prNumber: previous.prNumber,
        },
      };
    },
  };
}
