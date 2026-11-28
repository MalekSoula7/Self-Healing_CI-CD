// The retry after red CI (SPEC §9.1, P5.3d): while the failure has attempts left, a second heal
// starts on PipeHeal's own commit with what CI said about it (logs fetched read-only, cleaned and
// redacted, shown to the model as untrusted data). The database claim applies the same caps and
// in-flight rule as the first dispatch, the new failure passes the same policy gates (category,
// scope, setup), and nothing starts unless HEAL_DISPATCH is on.
import {
  classifyHeuristically,
  combineClassifications,
  triageLog,
  type Classification,
} from "@pipeheal/agent-core";
import type { RetryClaimInput, SystemScope } from "@pipeheal/db";
import type { GitHubApp, ReadOnlyRepoClient, WorkflowRun } from "@pipeheal/github";
import { effectivePolicy } from "@pipeheal/policy";
import type { Logger } from "@pipeheal/shared/logger";
import { dispatchDecision } from "../dispatch-decision";
import { MAX_ATTEMPTS_PER_DAY, startHealerRun } from "./dispatch";
import { fetchLog } from "./triage";
import type { Verifiable } from "./verify";

/** The most failed jobs a retry keeps (retryFeedbackSchema's bound). */
const MAX_JOBS = 10;

export interface Retry {
  githubApp: GitHubApp;
  dispatchEnabled: boolean;
}

type Feedback = RetryClaimInput["feedback"];

interface Classified {
  jobName: string;
  classification: Classification;
}

/** What CI said: each failed job's redacted error window, and what the heuristics make of it. */
async function readFeedback(
  reader: ReadOnlyRepoClient,
  runs: readonly WorkflowRun[],
): Promise<{ feedback: Feedback; classified: Classified[] }> {
  const feedback: Feedback = [];
  const classified: Classified[] = [];
  for (const run of runs) {
    for (const job of await reader.listFailedJobs(run.id, run.runAttempt)) {
      if (feedback.length >= MAX_JOBS) return { feedback, classified };
      const fetched = await fetchLog(reader, job.id);
      const conclusion = job.conclusion === "timed_out" ? "timed_out" : "failure";
      // A job whose log is gone is kept all the same: it still has to pass again.
      const triaged =
        fetched === null ? null : triageLog(fetched.text, { failedStep: job.failedStep });
      const classification =
        triaged === null
          ? null
          : classifyHeuristically({
              window: triaged.window,
              signals: triaged.signals,
              conclusion,
            });
      if (classification !== null) classified.push({ jobName: job.name, classification });
      feedback.push({
        workflowId: String(run.workflowId),
        name: job.name.slice(0, 500),
        failedStep: job.failedStep?.slice(0, 500) ?? null,
        summary: classification?.summary.slice(0, 2_000) ?? null,
        errorWindow: triaged?.window.slice(0, 200_000) ?? "",
      });
    }
  }
  return { feedback, classified };
}

/** Starts the retry if one is allowed. True only when a healer run was started for it. */
export async function startRetry(
  deps: Retry,
  system: SystemScope,
  attempt: Verifiable,
  failed: readonly WorkflowRun[],
  log: Logger,
): Promise<boolean> {
  if (!deps.dispatchEnabled) return false;
  const repo = await system.repositories.get(attempt.failure.repo.id);
  if (repo === null) return false;
  const { policy } = effectivePolicy(await system.policies.layers(repo.id));
  if (attempt.attemptNo >= policy.limits.maxAttemptsPerFailure) return false;
  const { installationId } = attempt.org;
  const reader = await deps.githubApp.readOnlyRepo(installationId, repo);
  const { feedback, classified } = await readFeedback(reader, failed);
  const decision = dispatchDecision(
    {
      category:
        classified.length === 0 ? null : combineClassifications(classified).category.toUpperCase(),
      // The branch the failure was on: PipeHeal's own is never in a policy's scope.
      headBranch: attempt.failure.headBranch,
      runs: failed.map((run) => ({ workflowPath: run.path, conclusion: run.conclusion ?? "" })),
      commands: repo.commands,
      workflows: await system.workflows.listForRepo(repo.id),
    },
    policy,
  );
  if (decision.kind !== "dispatch") {
    log.info({ attemptId: attempt.id, reason: decision.reason }, "no retry");
    return false;
  }
  const claim = await system.attempts.claimRetry({
    previousAttemptId: attempt.id,
    failingCheck: decision.failingCheck,
    feedback,
    maxAttemptsPerFailure: policy.limits.maxAttemptsPerFailure,
    maxAttemptsPerDay: MAX_ATTEMPTS_PER_DAY,
  });
  if (claim.outcome !== "created") {
    log.info({ attemptId: attempt.id, outcome: claim.outcome }, "no retry");
    return false;
  }
  const outcome = await startHealerRun(
    deps.githubApp,
    system,
    repo,
    installationId,
    claim.attempt,
    log,
  );
  return outcome === "dispatched";
}
