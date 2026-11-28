// The reconciler (SPEC §2.2, P5.3b): every non-terminal state has a timeout, so nothing waits
// forever on a webhook, a job or a runner that is gone. Each sweep, for what is overdue:
// - an attempt whose healer never started, or whose session ran out, fails;
// - a lost validation or publish job is queued again, and given up on after 2 hours;
// - an interrupted publish is finished from what GitHub has: its PR recorded, or the attempt failed;
// - an open pull request is verified (a webhook may be missed), or after its timeout UNVERIFIED;
// - a failure left HEALING by an ended attempt, or waiting on a re-run that never reported, settles.
// Each item stands alone: one that errors is logged and tried again next sweep.
import {
  ConflictError,
  NotFoundError,
  RECONCILE_AFTER_MS,
  forSystem,
  reconciliation,
  type Db,
  type Reconciliation,
  type SystemScope,
} from "@pipeheal/db";
import type { GitHubApp } from "@pipeheal/github";
import type { Logger } from "@pipeheal/shared/logger";
import { pauseIfRateLimited, type InstallationPacing } from "../pacing";
import { unverifiedComment } from "../pr/comments";
import { recordUnpublishable } from "./publish";
import {
  enqueuePublish,
  enqueueValidation,
  isSubmissionQueued,
  type SubmissionsQueue,
} from "./submissions";
import { recordUncheckable } from "./validate";
import { verifyAttempt, type Verifiable, type VerifyOutcome } from "./verify";

const minutes = (count: number) => count * 60_000;

/** SPEC §2.2's timeouts, and when to stop trying to ask GitHub. */
export const RECONCILE_TIMEOUTS_MS = {
  /** A submission still unchecked or unpublished. */
  submission: minutes(2 * 60),
  /** No watched run started, or none proves the fix. */
  ciStart: minutes(30),
  ciFinish: minutes(6 * 60),
  github: minutes(24 * 60),
} as const;

export interface ReconcileDeps {
  db: Db;
  githubApp: GitHubApp | null;
  pacing: InstallationPacing;
  submissions: SubmissionsQueue;
  logger: Logger;
  now?: () => Date;
  /** The overdue work, from the database; tests narrow it to their own rows. */
  due?: (now: Date) => ReturnType<Reconciliation["due"]>;
}

interface Item {
  orgId: string;
  attemptId: string;
  since: Date;
}

export async function reconcile(deps: ReconcileDeps): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const due = await (deps.due ?? ((at) => reconciliation(deps.db).due(at)))(now);
  const age = (item: Item) => now.getTime() - item.since.getTime();

  /** Runs `work` for each item in its organization; one failure never stops the sweep. */
  async function each<T extends { orgId: string }>(
    what: string,
    items: readonly T[],
    work: (system: SystemScope, item: T) => Promise<void>,
  ): Promise<void> {
    for (const item of items) {
      try {
        await work(await forSystem(deps.db, item.orgId, "reconciler"), item);
      } catch (error) {
        // Gone (uninstalled, deleted) or moved on since the listing: nothing to do.
        if (error instanceof NotFoundError || error instanceof ConflictError) continue;
        // The item holds IDs and times only.
        const details: Record<string, unknown> = {
          ...item,
          what,
          error: error instanceof Error ? error.name : "unknown",
        };
        deps.logger.warn(details, "reconciling failed");
      }
    }
  }

  await each("expired", due.expired, async (system, item) => {
    const reason = await system.attempts.expire(item.attemptId, now);
    if (reason !== null) {
      deps.logger.info({ attemptId: item.attemptId, reason }, "attempt expired");
    }
  });

  await each("submission", due.submissions, async (_system, item) => {
    const name = item.status === "VALIDATING" ? "validate" : "publish";
    if (await isSubmissionQueued(deps.submissions, name, item.attemptId)) return;
    const job = { orgId: item.orgId, attemptId: item.attemptId };
    if (age(item) < RECONCILE_TIMEOUTS_MS.submission) {
      await (name === "validate" ? enqueueValidation : enqueuePublish)(deps.submissions, job);
      return;
    }
    await (name === "validate" ? recordUncheckable : recordUnpublishable)(deps.db, job);
    deps.logger.warn({ attemptId: item.attemptId, job: name }, "gave up on a submission");
  });

  await each("publishing", due.publishing, async (system, item) => {
    await finishPublish(deps, system, item, age(item));
  });

  await each("verification", due.opened, async (system, item) => {
    await checkVerification(deps, system, item, age(item));
  });

  await each("unsettled", due.unsettled, async (system, item) => {
    await system.attempts.settleFailure(item.attemptId);
  });

  await each("rerun", due.reruns, async (system, item) => {
    await system.failures.settle(item.failureId, {
      status: "SKIPPED",
      reason: `the flaky re-run didn't report within ${String(RECONCILE_AFTER_MS.rerun / 3_600_000)} hours`,
    });
  });
}

/** The installation's GitHub calls wait while GitHub rate-limits it. */
async function github<T>(
  deps: ReconcileDeps,
  installationId: bigint,
  work: () => Promise<T>,
): Promise<T | "paused"> {
  if ((await deps.pacing.pausedUntil(installationId)) !== null) return "paused";
  try {
    return await work();
  } catch (error) {
    await pauseIfRateLimited(deps.pacing, installationId, error);
    throw error;
  }
}

/**
 * A publish interrupted after its claim (P5.2 review M3): nothing is written again. The PR GitHub
 * has for the attempt's branch is recorded; without one the attempt fails.
 */
async function finishPublish(
  deps: ReconcileDeps,
  system: SystemScope,
  item: Item,
  age: number,
): Promise<void> {
  const found = await system.attempts.publication(item.attemptId);
  if (found?.status !== "PUBLISHING") return;
  const { branch, commitSha } = found;
  const fail = async (reason: string) => {
    await system.attempts.failPublish(item.attemptId, reason);
    deps.logger.warn({ attemptId: item.attemptId, reason }, "publish didn't finish");
  };
  if (branch === null || commitSha === null) {
    await fail("publishing was interrupted before the commit was recorded");
    return;
  }
  const app = deps.githubApp;
  if (app === null) return;
  const { installationId } = found.org;
  try {
    const pulls = await github(deps, installationId, async () =>
      (await app.installation(installationId))
        .repo(found.failure.repo.fullName)
        .findPullRequestsByHead(branch),
    );
    if (pulls === "paused") return;
    // The one PipeHeal opens: from its branch into the failing branch.
    const pull = pulls.find((candidate) => candidate.baseRef === found.failure.headBranch);
    if (pull === undefined) {
      await fail("publishing was interrupted before the pull request was opened");
      return;
    }
    await system.attempts.recordPullRequest(item.attemptId, {
      number: pull.number,
      url: pull.htmlUrl,
      draft: pull.draft,
    });
    deps.logger.info({ attemptId: item.attemptId, pr: pull.number }, "pull request recovered");
  } catch (error) {
    if (age < RECONCILE_TIMEOUTS_MS.github) throw error;
    await fail("the pull request couldn't be confirmed on GitHub");
  }
}

/** The §2.2 reason a pull request still unanswered after `age` is given up on, if it is. */
function overdue(outcome: VerifyOutcome, age: number): string | null {
  if (outcome === "waiting-for-start" && age >= RECONCILE_TIMEOUTS_MS.ciStart) {
    return "no CI run of a watched workflow started on the pull request";
  }
  if (outcome === "waiting-for-proof" && age >= RECONCILE_TIMEOUTS_MS.ciStart) {
    return "the workflow that failed didn't run and pass on the pull request";
  }
  if (age >= RECONCILE_TIMEOUTS_MS.ciFinish && outcome !== "recorded") {
    return "CI didn't finish within 6 hours";
  }
  return null;
}

async function checkVerification(
  deps: ReconcileDeps,
  system: SystemScope,
  item: Item,
  age: number,
): Promise<void> {
  const attempt = await system.attempts.forVerification(item.attemptId);
  if (attempt?.status !== "PR_OPENED") return;
  const { repo } = attempt.failure;
  if (attempt.org.status !== "ACTIVE" || !repo.enabled || repo.removedFromInstallationAt !== null) {
    // Never act on it: recorded only, without a GitHub call.
    await system.attempts.recordVerification(attempt.id, {
      result: "unverified",
      reason: "the organization or repository is no longer enabled",
    });
    return;
  }
  const app = deps.githubApp;
  if (app === null) return;
  const log = deps.logger.child({ attemptId: attempt.id });
  let outcome: VerifyOutcome | "paused";
  try {
    outcome = await github(deps, attempt.org.installationId, () =>
      verifyAttempt(app, system, attempt, log),
    );
  } catch (error) {
    if (age < RECONCILE_TIMEOUTS_MS.github) throw error;
    await system.attempts.recordVerification(attempt.id, {
      result: "unverified",
      reason: "GitHub couldn't be asked about CI",
    });
    return;
  }
  if (outcome === "paused") return;
  const reason = overdue(outcome, age);
  if (reason !== null) await giveUp(app, system, attempt, reason, log);
}

/** UNVERIFIED, with one comment on the pull request while it is still open. */
async function giveUp(
  app: GitHubApp,
  system: SystemScope,
  attempt: Verifiable,
  reason: string,
  log: Logger,
): Promise<void> {
  const { changed } = await system.attempts.recordVerification(attempt.id, {
    result: "unverified",
    reason,
  });
  if (!changed || attempt.prNumber === null) return;
  log.info({ reason }, "fix not verified");
  try {
    const client = (await app.installation(attempt.org.installationId)).repo(
      attempt.failure.repo.fullName,
    );
    if ((await client.getPullRequest(attempt.prNumber)).state !== "open") return;
    await client.comment(attempt.prNumber, unverifiedComment(reason));
  } catch (error) {
    log.warn(
      { error: error instanceof Error ? error.name : "unknown" },
      "couldn't comment on the pull request",
    );
  }
}
