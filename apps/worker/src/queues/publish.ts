// Opening the pull request for a validated attempt (SPEC §2 step 11, §9, P5.2c), the `submissions`
// queue's `publish` job. In order:
// 1. Re-check what will be committed: the stored submission must be exactly what was validated
//    (its digest, P5.1 review L1), the org and repository still enabled.
// 2. Claim the attempt (VALIDATED -> PUBLISHING) with its `pipeheal/*` branch. From here nothing is
//    retried: a write whose outcome is unknown ends the attempt rather than risk a second commit or
//    PR. A retried job finds the attempt PUBLISHING and stops.
// 3. Commit the files on a new branch from the target commit (packages/github's guarded
//    `commitFiles`: `pipeheal/*` only, never `.github/`, never forced), record the branch and its
//    commit, then open the PR against the failing branch, a draft per the policy (§9).
// 4. Best effort, after the PR exists: the `pipeheal` label, a review request to the failing
//    commit's author, a comment on the failing branch's open PR. Their failures are logged only.
// PipeHeal never merges: there is no merge call anywhere (packages/github has none).
import {
  fixSummarySchema,
  forSystem,
  submissionValidationSchema,
  testInventoryRecordSchema,
  type Db,
  type SystemScope,
} from "@pipeheal/db";
import {
  GitHubApiError,
  GuardError,
  type FileChange,
  type GitHubApp,
  type RepoClient,
} from "@pipeheal/github";
import { effectivePolicy } from "@pipeheal/policy";
import type { Logger } from "@pipeheal/shared/logger";
import { submissionSchema } from "@pipeheal/shared/protocol";
import { ZodError } from "zod";
import { isDraft, prBody, prTitle } from "../pr/body";
import { retryPushedComment } from "../pr/comments";
import { submissionDigest } from "../submission-check";
import type { ValidationJob } from "./submissions";

export interface PublishDeps {
  db: Db;
  githubApp: GitHubApp | null;
  /** HEAL_MODEL, named in the PR body. */
  model: string;
}

type Publication = NonNullable<Awaited<ReturnType<SystemScope["attempts"]["publication"]>>>;

/**
 * After a publish job's last retry failed before it claimed anything (P5.2 review M3): the
 * VALIDATED attempt ends FAILED rather than waiting forever. Nothing was written to GitHub.
 */
export async function recordUnpublishable(db: Db, job: ValidationJob): Promise<void> {
  const system = await forSystem(db, job.orgId, "publisher");
  const found = await system.attempts.publication(job.attemptId);
  if (found?.status !== "VALIDATED") return;
  const branch = healBranchName(found.failure.id, found.attemptNo);
  if (await system.attempts.claimPublish(job.attemptId, branch)) {
    await system.attempts.failPublish(job.attemptId, "the pull request couldn't be opened");
  }
}

/** The attempt's branch: unique per failure (a UUIDv7's random tail) and attempt. */
export function healBranchName(failureId: string, attemptNo: number): string {
  return `pipeheal/${failureId.replaceAll("-", "").slice(-10)}-${String(attemptNo)}`;
}

/** PipeHeal's own words only: model text never reaches a commit message. */
function commitMessage(failingCheck: string, attemptNo: number, targetSha: string): string {
  return [
    `fix: repair the failing ${failingCheck} check`,
    "",
    `PipeHeal attempt ${String(attemptNo)} on ${targetSha.slice(0, 12)}. The pull request says`,
    "what failed, what changed and how it was checked.",
  ].join("\n");
}

function testCount(record: unknown): number | null {
  const parsed = testInventoryRecordSchema.safeParse(record);
  if (!parsed.success || !parsed.data.available) return null;
  return parsed.data.tests.reduce((total, [, outcomes]) => total + outcomes.length, 0);
}

/** The stored validation, summary and files, re-validated; null when they don't parse. */
function readStored(found: Publication) {
  try {
    return {
      validation: submissionValidationSchema.parse(found.validation),
      fix: found.fix === null ? null : fixSummarySchema.parse(found.fix),
      files: submissionSchema.shape.files.parse(found.submission?.files),
    };
  } catch (error) {
    if (error instanceof ZodError) return null;
    throw error;
  }
}

type StoredPublication = NonNullable<ReturnType<typeof readStored>>;

function fileChanges(files: StoredPublication["files"]): FileChange[] {
  return files.map((file) => ("deleted" in file ? { path: file.path, delete: true } : file));
}

/** Why a write to GitHub failed, in PipeHeal's words. */
function writeFailure(error: unknown): string {
  if (error instanceof GuardError) return "the change can't be committed safely";
  if (error instanceof GitHubApiError) return "GitHub refused the commit or the pull request";
  return "the pull request couldn't be opened";
}

/**
 * A retry's fix (P5.3d): one more commit on the same branch, never forced, and only while the
 * branch and the open PR still sit on the commit whose CI failed. No new PR; a comment says what
 * was pushed.
 */
async function publishRetry(
  system: SystemScope,
  client: RepoClient,
  found: Publication,
  stored: StoredPublication,
  log: Logger,
): Promise<void> {
  const { id, targetSha } = found;
  const previous = (await system.attempts.chain(id))?.previous;
  const branch = previous?.branch ?? healBranchName(found.failure.id, found.attemptNo);
  const stopBefore = async (reason: string) => {
    if (await system.attempts.claimPublish(id, branch)) {
      await system.attempts.failPublish(id, reason);
    }
    log.warn({ attemptId: id, reason }, "retry not pushed");
  };
  if (previous?.branch == null || previous.prNumber === null) {
    await stopBefore("the earlier attempts' changes couldn't be read");
    return;
  }
  if (previous.status !== "CI_FAILED" || previous.commitSha !== targetSha) {
    await stopBefore("the earlier fix is no longer failing CI");
    return;
  }
  // Reads before the claim: an error retries the job with nothing written.
  if ((await client.getBranchSha(branch)) !== targetSha) {
    await stopBefore("the pull request's branch moved");
    return;
  }
  const pull = await client.getPullRequest(previous.prNumber);
  if (
    pull.state !== "open" ||
    pull.fromFork ||
    pull.headRef !== branch ||
    pull.headSha !== targetSha
  ) {
    await stopBefore("the pull request is no longer open on PipeHeal's commit");
    return;
  }
  if (!(await system.attempts.claimPublish(id, branch))) return;
  let commitSha;
  try {
    ({ commitSha } = await client.commitFiles({
      branch,
      parentSha: targetSha,
      message: commitMessage(found.failingCheck, found.attemptNo, targetSha),
      changes: fileChanges(stored.files),
      createBranch: false,
    }));
    await system.attempts.recordCommit(id, commitSha);
  } catch (error) {
    await system.attempts.failPublish(id, writeFailure(error));
    log.warn(
      { attemptId: id, error: error instanceof Error ? error.name : "unknown" },
      "retry not pushed",
    );
    return;
  }
  // The commit is on the PR: never marked FAILED from here (the reconciler finds it).
  const record = { number: pull.number, url: pull.htmlUrl, draft: pull.draft };
  await system.attempts.recordPullRequest(id, record);
  log.info({ attemptId: id, pr: pull.number }, "retry pushed");
  try {
    await client.comment(
      pull.number,
      retryPushedComment(
        commitSha,
        stored.files.map((file) => file.path),
        stored.fix?.rootCause ?? null,
        stored.validation.draftReasons,
      ),
    );
  } catch (error) {
    log.warn(
      { attemptId: id, error: error instanceof Error ? error.name : "unknown" },
      "couldn't comment on the pull request",
    );
  }
}

export async function publishAttempt(
  deps: PublishDeps,
  job: ValidationJob,
  log: Logger,
): Promise<void> {
  const system = await forSystem(deps.db, job.orgId, "publisher");
  const found = await system.attempts.publication(job.attemptId);
  if (found?.status !== "VALIDATED") return;
  const { failure } = found;
  const { repo } = failure;
  if (found.org.status !== "ACTIVE" || !repo.enabled || repo.removedFromInstallationAt !== null) {
    log.info({ attemptId: job.attemptId }, "pull request not opened: repository no longer enabled");
    return;
  }
  // Thrown before any claim: the job retries, nothing was written.
  const app = deps.githubApp;
  if (app === null) throw new Error("GitHub App isn't configured");

  const branch = healBranchName(failure.id, found.attemptNo);
  const stopBefore = async (reason: string) => {
    if (await system.attempts.claimPublish(job.attemptId, branch)) {
      await system.attempts.failPublish(job.attemptId, reason);
    }
    log.warn({ attemptId: job.attemptId, reason }, "pull request not opened");
  };

  const stored = readStored(found);
  if (stored === null) {
    await stopBefore("the stored submission couldn't be read");
    return;
  }
  const { validation, fix, files } = stored;
  // Commit exactly what was checked (P5.1 review L1).
  if (!validation.passed || validation.digest !== submissionDigest(found.targetSha, files)) {
    await stopBefore("the submission isn't the one that was checked");
    return;
  }
  if (found.retryOfId !== null) {
    const client = (await app.installation(found.org.installationId)).repo(repo.fullName);
    await publishRetry(system, client, found, stored, log);
    return;
  }
  const base = failure.headBranch;
  if (base === null) {
    await stopBefore("the failure has no branch to open a pull request against");
    return;
  }
  // A merge queue's branch is GitHub's, temporary: never a base (P5.2 review M1).
  if (base.startsWith("gh-readonly-queue/")) {
    await stopBefore("the failure ran in a merge queue, not on a branch");
    return;
  }
  const { policy } = effectivePolicy(await system.policies.layers(repo.id));
  const draft = isDraft(fix, validation, policy.review.draftBelowConfidence);
  const after = testCount(found.submission?.afterTests);
  const baseline = testCount(found.baselineTests);
  const title = prTitle(fix);
  const body = prBody({
    failure: {
      headSha: failure.headSha,
      category: failure.category,
      jobs: failure.runs
        .filter((run) => run.conclusion !== "success")
        .flatMap((run) =>
          run.jobs.map((failed) => ({
            workflowName: run.workflowName,
            jobName: failed.name,
            failedStep: failed.failedStep,
            runUrl: run.htmlUrl,
          })),
        ),
    },
    fix,
    files: files.map((file) => file.path),
    failingCheck: found.failingCheck,
    validation,
    tests: after === null || baseline === null ? null : { after, baseline },
    attempt: {
      attemptNo: found.attemptNo,
      iterations: found.iterations,
      model: deps.model,
      timelineUrl: null,
    },
  });

  // Reads before the claim (an error retries the job; nothing was written): the base still
  // exists and still holds the healed commit, so the PR proposes only the fix (P5.2 review
  // M1); the PR's branch doesn't exist yet (L5).
  const client = (await app.installation(found.org.installationId)).repo(repo.fullName);
  let tip: string | null;
  try {
    tip = await client.getBranchSha(base);
  } catch (error) {
    if (!(error instanceof GuardError)) throw error;
    await stopBefore("the failing branch's name can't be used as a base");
    return;
  }
  if (tip === null) {
    await stopBefore("the failing branch no longer exists");
    return;
  }
  if (tip !== found.targetSha) {
    const comparison = await client.compareCommits(found.targetSha, tip);
    if (comparison.status !== "ahead") {
      await stopBefore("the failing branch moved away from the healed commit");
      return;
    }
  }
  if ((await client.getBranchSha(branch)) !== null) {
    await stopBefore("the pull request's branch already exists");
    return;
  }

  // From here on, nothing is retried.
  if (!(await system.attempts.claimPublish(job.attemptId, branch))) return;
  const changes = fileChanges(files);
  let pull;
  let commitSha;
  try {
    ({ commitSha } = await client.commitFiles({
      branch,
      parentSha: found.targetSha,
      message: commitMessage(found.failingCheck, found.attemptNo, found.targetSha),
      changes,
      createBranch: true,
    }));
    await system.attempts.recordCommit(job.attemptId, commitSha);
    pull = await client.createPullRequest({ head: branch, base, title, body, draft });
  } catch (error) {
    const reason = writeFailure(error);
    await system.attempts.failPublish(job.attemptId, reason);
    log.warn(
      { attemptId: job.attemptId, error: error instanceof Error ? error.name : "unknown" },
      "pull request not opened",
    );
    return;
  }
  // The PR exists: from here the attempt is never marked FAILED (P5.2 review M3). A database
  // error leaves it PUBLISHING for the §2.2 reconciler, which finds the PR by its branch.
  const record = { number: pull.number, url: pull.htmlUrl, draft: pull.draft };
  try {
    await system.attempts.recordPullRequest(job.attemptId, record);
  } catch {
    await system.attempts.recordPullRequest(job.attemptId, record);
  }
  // What GitHub opened is what PipeHeal committed (P5.2 review L1): a mismatch means someone
  // pushed to the branch in between. P5.3 only calls a PR verified for its recorded commit.
  if (pull.headSha !== commitSha || pull.headRef !== branch || pull.baseRef !== base) {
    log.warn(
      { attemptId: job.attemptId, pr: pull.number },
      "pull request head isn't PipeHeal's commit",
    );
  }
  log.info(
    { attemptId: job.attemptId, pr: pull.number, draft: pull.draft, files: changes.length },
    "pull request opened",
  );

  // Best effort: the PR exists; these only help people find and review it.
  const repoClient = client;
  const { number, htmlUrl } = pull;
  const extra = async (what: string, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      log.warn(
        { attemptId: job.attemptId, what, error: error instanceof Error ? error.name : "unknown" },
        "pull request follow-up failed",
      );
    }
  };
  await extra("label", () => repoClient.addLabels(number, ["pipeheal"]));
  if (policy.review.requestCommitAuthor) {
    await extra("reviewer", async () => {
      const login = await repoClient.commitAuthorLogin(failure.headSha);
      if (login !== null) await repoClient.requestReviewers(number, [login]);
    });
  }
  await extra("link comment", async () => {
    const origin = await repoClient.openPullRequestFor(base);
    if (origin !== null && origin.number !== number) {
      await repoClient.comment(
        origin.number,
        `PipeHeal opened ${htmlUrl} to fix the CI failure on this branch. Review it like any other pull request; PipeHeal never merges.`,
      );
    }
  });
}
