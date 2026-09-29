// Triage of a failure once its collection window has closed (SPEC §2 step 5, §6.2 steps 1-5):
// download each failed job's log, then (agent-core's triageLog) take the failed step, clean and
// redact it, and store its error window and signals. The classifier (P2.4) builds on these. Only
// redacted text ever reaches the database or the logs.
import { triageLog } from "@pipeheal/agent-core";
import { forSystem, type Db } from "@pipeheal/db";
import { GitHubApiError, type GitHubApp, type JobLog, type RepoClient } from "@pipeheal/github";
import type { Logger } from "@pipeheal/shared/logger";

export interface FailureTarget {
  orgId: string;
  failureId: string;
  installationId: bigint;
}

export interface TriageDeps {
  db: Db;
  githubApp: GitHubApp | null;
}

/** The job's log, or null when GitHub no longer has it (logs expire; a job can be deleted). */
async function fetchLog(repoClient: RepoClient, githubJobId: bigint): Promise<JobLog | null> {
  try {
    return await repoClient.downloadJobLog(githubJobId);
  } catch (error) {
    if (error instanceof GitHubApiError && (error.status === 404 || error.status === 410)) {
      return null;
    }
    throw error;
  }
}

/** Triages every failed job of the failure not triaged yet. Safe to repeat. */
export async function triageFailure(
  deps: TriageDeps,
  target: FailureTarget,
  log: Logger,
): Promise<void> {
  const system = await forSystem(deps.db, target.orgId, "triage");
  const failure = await system.failures.get(target.failureId);
  if (failure === null) return;
  const pending = failure.runs.flatMap((run) => run.jobs.filter((job) => job.errorWindow === null));
  if (pending.length === 0) return;
  const repo = await system.repositories.get(failure.repoId);
  if (repo === null) return;
  if (deps.githubApp === null) {
    log.warn("GitHub App isn't configured; skipping triage");
    return;
  }
  const repoClient = (await deps.githubApp.installation(target.installationId)).repo(repo.fullName);

  for (const job of pending) {
    const fetched = await fetchLog(repoClient, job.githubJobId);
    if (fetched === null) {
      // GitHub no longer has the log: an empty window marks the job as triaged.
      await system.failures.recordJobTriage(job.id, { errorWindow: "" });
      log.info({ failedJobId: job.id }, "job log unavailable");
      continue;
    }
    const { window, signals, redactions } = triageLog(fetched.text, {
      failedStep: job.failedStep,
    });
    await system.failures.recordJobTriage(job.id, { errorWindow: window, signals, redactions });
    log.info(
      {
        failedJobId: job.id,
        truncated: fetched.truncated,
        lines: window.split("\n").length,
        tools: signals.tools,
        errorCodes: signals.errorCodes,
        redactions,
      },
      "job log triaged",
    );
  }
}
