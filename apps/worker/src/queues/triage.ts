// Triage of a failure once its collection window has closed (SPEC §2 step 5, §6.2). For now
// steps 1–3: download each failed job's log, clean it, redact it, and store it as the job's
// error window. The error-window extractor and signals (P2.3) and the classifier (P2.4) build on
// this. Only redacted text ever reaches the database or the logs.
import { cleanLog, redactLog } from "@pipeheal/agent-core";
import { forSystem, type Db } from "@pipeheal/db";
import { GitHubApiError, type GitHubApp, type JobLog, type RepoClient } from "@pipeheal/github";
import type { Logger } from "@pipeheal/shared/logger";

/**
 * Until P2.3's extractor: the tail of the failed step (SPEC §6.2 step 4), capped at this many
 * lines. The failed step ends with its `##[error]` line; post-job steps (checkout's cleanup) follow
 * it in the job log and would otherwise fill the window.
 */
export const ERROR_WINDOW_LINES = 300;
const ERROR_WINDOW_MAX_CHARS = 100_000;

export interface FailureTarget {
  orgId: string;
  failureId: string;
  installationId: bigint;
}

export interface TriageDeps {
  db: Db;
  githubApp: GitHubApp | null;
}

function provisionalWindow(text: string): string {
  const lines = text.trimEnd().split("\n");
  const lastError = lines.findLastIndex((line) => line.startsWith("##[error]"));
  const failedStep = lastError === -1 ? lines : lines.slice(0, lastError + 1);
  return failedStep.slice(-ERROR_WINDOW_LINES).join("\n").slice(-ERROR_WINDOW_MAX_CHARS);
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

/** Fetches, cleans and redacts the log of every failed job not triaged yet. Safe to repeat. */
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
    const { text, redactions } = redactLog(fetched === null ? "" : cleanLog(fetched.text));
    const errorWindow = provisionalWindow(text);
    await system.failures.recordJobTriage(job.id, { errorWindow, redactions });
    log.info(
      {
        failedJobId: job.id,
        available: fetched !== null,
        truncated: fetched?.truncated ?? false,
        lines: errorWindow === "" ? 0 : errorWindow.split("\n").length,
        redactions,
      },
      "job log triaged",
    );
  }
}
