// Verification (SPEC §9.1, P5.3a): what CI says about the commit PipeHeal created. The runs are
// read from GitHub (a webhook only says "look again"), and only these count: watched workflows,
// this repository's own code, on PipeHeal's branch. Green is VERIFIED; red leaves the failure to a
// person, with one comment on the PR. A branch someone else pushed to is never called verified or
// failed. Nothing here writes code, and nothing merges.
import type { SystemScope } from "@pipeheal/db";
import { HEALER_WORKFLOW_PATH, TRUSTED_RUN_EVENTS, type GitHubApp } from "@pipeheal/github";
import type { Logger } from "@pipeheal/shared/logger";
import { ciVerdict } from "../ci-verdict";
import { ciFailedComment, type FailedCiJob } from "../pr/comments";

export type Verifiable = NonNullable<Awaited<ReturnType<SystemScope["attempts"]["forCommit"]>>>;

/** The "waiting-for-" outcomes mean no answer yet; the §2.2 timeouts treat each differently. */
export type VerifyOutcome = "recorded" | "skipped" | `waiting-for-${"start" | "finish" | "proof"}`;

/** Failed runs whose jobs are listed for the comment. */
const MAX_RUNS_DETAILED = 5;

export async function verifyAttempt(
  githubApp: GitHubApp,
  system: SystemScope,
  attempt: Verifiable,
  log: Logger,
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
  const required = new Set(
    originalRuns.filter((run) => run.conclusion !== "success").map((run) => run.workflowId),
  );
  const verdict = ciVerdict(runs, required);
  if (verdict.kind === "pending") return `waiting-for-${verdict.waitingFor}`;

  const client = (await githubApp.installation(installationId)).repo(repo.fullName);
  const pull = await client.getPullRequest(prNumber);
  if (pull.fromFork) return "skipped";
  // Only PipeHeal's own commit is verified (P5.2 review L1).
  if (pull.headSha !== commitSha) {
    await system.attempts.recordVerification(attempt.id, {
      result: "unverified",
      reason: "someone else pushed to the pull request's branch",
    });
    log.info({ attemptId: attempt.id }, "not verified: the branch moved");
    return "recorded";
  }
  if (verdict.kind === "green") {
    const { changed } = await system.attempts.recordVerification(attempt.id, {
      result: "verified",
    });
    if (changed) log.info({ attemptId: attempt.id, pr: prNumber }, "fix verified by CI");
    return "recorded";
  }

  // Read before recording: an error here retries the job with nothing recorded.
  const jobs: FailedCiJob[] = [];
  for (const run of verdict.failed.slice(0, MAX_RUNS_DETAILED)) {
    const from = { workflowName: run.name ?? run.path, runUrl: run.htmlUrl };
    const failed = await reader.listFailedJobs(run.id, run.runAttempt);
    if (failed.length === 0) jobs.push({ ...from, jobName: null, failedStep: null });
    for (const job of failed) {
      jobs.push({ ...from, jobName: job.name, failedStep: job.failedStep });
    }
  }
  const { changed } = await system.attempts.recordVerification(attempt.id, {
    result: "failed",
    reason: "CI failed on PipeHeal's commit",
  });
  if (!changed) return "recorded";
  log.info({ attemptId: attempt.id, pr: prNumber }, "CI failed on the fix: needs a person");
  if (pull.state !== "open") return "recorded";
  // After the record, so it is posted at most once; a failure to post is only logged.
  try {
    await client.comment(prNumber, ciFailedComment(commitSha, jobs));
  } catch (error) {
    log.warn(
      { attemptId: attempt.id, error: error instanceof Error ? error.name : "unknown" },
      "couldn't comment on the pull request",
    );
  }
  return "recorded";
}
