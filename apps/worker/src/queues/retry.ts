// The retry after red CI (SPEC §9.1, P5.3d): while the failure has attempts left, a second heal
// starts on PipeHeal's own commit with what CI said about it (logs fetched read-only, cleaned and
// redacted, shown to the model as untrusted data). The database claim applies the same caps and
// in-flight rule as the first dispatch, and nothing starts unless HEAL_DISPATCH is on.
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
import { attemptCommandsSchema } from "@pipeheal/shared/protocol";
import { checkFor, type DispatchCheck } from "../dispatch-decision";
import { MAX_ATTEMPTS_PER_DAY, startHealerRun } from "./dispatch";
import { fetchLog } from "./triage";
import type { Verifiable } from "./verify";

/** The most failed jobs whose logs a retry reads. */
const MAX_JOBS = 5;

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
      if (fetched === null) continue;
      const { window, signals } = triageLog(fetched.text, { failedStep: job.failedStep });
      const classification = classifyHeuristically({
        window,
        signals,
        conclusion: job.conclusion === "timed_out" ? "timed_out" : "failure",
      });
      if (classification !== null) classified.push({ jobName: job.name, classification });
      feedback.push({
        name: job.name.slice(0, 500),
        failedStep: job.failedStep?.slice(0, 500) ?? null,
        summary: classification?.summary.slice(0, 2_000) ?? null,
        errorWindow: window.slice(0, 200_000),
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
  // The check the new failure shows in, when that's clear and configured; else the same as before.
  const commands = attemptCommandsSchema.safeParse(repo.commands ?? {});
  let failingCheck = attempt.failingCheck as DispatchCheck;
  if (classified.length > 0 && commands.success) {
    const shown = checkFor(combineClassifications(classified).category, commands.data);
    if (shown !== null && commands.data[shown] !== undefined) failingCheck = shown;
  }
  const claim = await system.attempts.claimRetry({
    previousAttemptId: attempt.id,
    failingCheck,
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
