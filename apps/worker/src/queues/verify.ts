// Verification (SPEC §9.1, P5.3a): what CI says about the commit PipeHeal created. The runs are
// read from GitHub (a webhook only says "look again"), and only these count: watched workflows,
// this repository's own code, on PipeHeal's branch. Green is VERIFIED; red leaves the failure to a
// person, with one comment on the PR, after starting a retry while one is left. A branch someone else pushed to is never called verified or
// failed. Nothing here writes code, and nothing merges.
import type { SystemScope } from "@pipeheal/db";
import {
  GitHubApiError,
  HEALER_WORKFLOW_PATH,
  TRUSTED_RUN_EVENTS,
  type GitHubApp,
  type ReadOnlyRepoClient,
  type WorkflowRun,
} from "@pipeheal/github";
import type { Logger } from "@pipeheal/shared/logger";
import { ciVerdict, isProof, jobsProven, type RanAgain } from "../ci-verdict";
import { ciFailedComment, type FailedCiJob } from "../pr/comments";
import { startRetry } from "./retry";

export type Verifiable = NonNullable<Awaited<ReturnType<SystemScope["attempts"]["forCommit"]>>>;

/** The "waiting-for-" outcomes mean no answer yet; the §2.2 timeouts treat each differently. */
export type VerifyOutcome = "recorded" | "skipped" | `waiting-for-${"start" | "finish" | "proof"}`;

/** Failed runs whose jobs are listed for the comment. */
const MAX_RUNS_DETAILED = 5;
/** Passing runs whose jobs are checked for proof. */
const MAX_PROOF_RUNS = 10;

/** The jobs of the passing runs of the workflows that failed originally. */
async function jobsThatRanAgain(
  reader: ReadOnlyRepoClient,
  runs: readonly WorkflowRun[],
  required: ReadonlySet<bigint>,
): Promise<RanAgain[]> {
  const proving = runs.filter((run) => isProof(run) && required.has(run.workflowId));
  const ran: RanAgain[] = [];
  for (const run of proving.slice(0, MAX_PROOF_RUNS)) {
    for (const job of await reader.listJobs(run.id, run.runAttempt)) {
      ran.push({ ...job, workflowId: run.workflowId });
    }
  }
  return ran;
}

/**
 * What the comment lists. A listing GitHub refuses leaves the run without its jobs: the verdict
 * matters more than the detail. A rate limit is thrown, so the installation pauses.
 */
async function failedJobsOf(
  reader: ReadOnlyRepoClient,
  runs: readonly WorkflowRun[],
): Promise<FailedCiJob[]> {
  const jobs: FailedCiJob[] = [];
  for (const run of runs.slice(0, MAX_RUNS_DETAILED)) {
    const from = { workflowName: run.name ?? run.path, runUrl: run.htmlUrl };
    let failed: Awaited<ReturnType<ReadOnlyRepoClient["listFailedJobs"]>> = [];
    try {
      failed = await reader.listFailedJobs(run.id, run.runAttempt);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.retryAt !== null) throw error;
    }
    if (failed.length === 0) jobs.push({ ...from, jobName: null, failedStep: null });
    for (const job of failed) {
      jobs.push({ ...from, jobName: job.name, failedStep: job.failedStep });
    }
  }
  return jobs;
}

export async function verifyAttempt(
  githubApp: GitHubApp,
  system: SystemScope,
  attempt: Verifiable,
  log: Logger,
  /** HEAL_DISPATCH: without it a red run never starts a retry. */
  dispatchEnabled = false,
): Promise<VerifyOutcome> {
  const { branch, commitSha, prNumber } = attempt;
  if (branch === null || commitSha === null || prNumber === null) return "skipped";
  const { repo, runs: originalRuns } = attempt.failure;
  const { installationId } = attempt.org;
  const reader = await githubApp.readOnlyRepo(installationId, repo);
  const watched = new Set(
    (await system.workflows.listForRepo(repo.id))
      .filter((workflow) => workflow.selected)
      .map((workflow) => workflow.githubWorkflowId),
  );
  const runs = (await reader.listRunsForSha(commitSha)).filter(
    (run) =>
      run.headSha === commitSha &&
      run.headBranch === branch &&
      !run.fromFork &&
      TRUSTED_RUN_EVENTS.has(run.event) &&
      run.path !== HEALER_WORKFLOW_PATH &&
      watched.has(run.workflowId),
  );
  const failedRuns = originalRuns.filter((run) => run.conclusion !== "success");
  const required = new Set(failedRuns.map((run) => run.workflowId));
  const verdict = ciVerdict(runs, required);
  if (verdict.kind === "pending") return `waiting-for-${verdict.waitingFor}`;
  if (verdict.kind === "green") {
    const originally = failedRuns.flatMap((run) =>
      run.jobs.map((job) => ({ ...job, workflowId: run.workflowId })),
    );
    if (!jobsProven(originally, await jobsThatRanAgain(reader, runs, required))) {
      return "waiting-for-proof";
    }
  }
  // Later listings only add runs and attempts: a higher sum is newer evidence.
  const seen = runs.reduce((sum, run) => sum + run.runAttempt, 0);

  const client = (await githubApp.installation(installationId)).repo(repo.fullName);
  const pull = await client.getPullRequest(prNumber);
  if (pull.fromFork) return "skipped";
  // Only PipeHeal's own commit is verified (P5.2 review L1).
  if (pull.headSha !== commitSha) {
    await system.attempts.recordVerification(attempt.id, {
      result: "unverified",
      reason: "someone else pushed to the pull request's branch",
      seen,
    });
    log.info({ attemptId: attempt.id }, "not verified: the branch moved");
    return "recorded";
  }
  if (verdict.kind === "green") {
    const { changed } = await system.attempts.recordVerification(attempt.id, {
      result: "verified",
      seen,
    });
    if (changed) log.info({ attemptId: attempt.id, pr: prNumber }, "fix verified by CI");
    return "recorded";
  }

  // Read before recording: an error here retries the job with nothing recorded.
  const jobs = await failedJobsOf(reader, verdict.failed);
  const { firstFailure } = await system.attempts.recordVerification(attempt.id, {
    result: "failed",
    reason: "CI failed on PipeHeal's commit",
    seen,
  });
  if (!firstFailure) return "recorded";
  log.info({ attemptId: attempt.id, pr: prNumber }, "CI failed on the fix: needs a person");
  if (pull.state !== "open") return "recorded";
  // Once, after the first failure was recorded: a second attempt while the failure has one left.
  let retrying = false;
  try {
    const retry = { githubApp, dispatchEnabled };
    retrying = await startRetry(retry, system, attempt, verdict.failed, log);
  } catch (error) {
    log.warn(
      { attemptId: attempt.id, error: error instanceof Error ? error.name : "unknown" },
      "couldn't start a retry",
    );
  }
  // After the record, so it is posted at most once; a failure to post is only logged.
  try {
    await client.comment(prNumber, ciFailedComment(commitSha, jobs, retrying));
  } catch (error) {
    log.warn(
      { attemptId: attempt.id, error: error instanceof Error ? error.name : "unknown" },
      "couldn't comment on the pull request",
    );
  }
  return "recorded";
}
