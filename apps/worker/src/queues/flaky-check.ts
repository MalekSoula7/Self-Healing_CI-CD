// The flaky check (SPEC §6.2 step 8): once triage has classified a failure, re-run each failed
// run's failed jobs once (`rerun-failed-jobs`, never the whole run). The re-run's result arrives
// as a newer attempt of the same run: the workflow_run processor records it against the failure
// (recordPassedRun → FLAKY once every run passed; recordFailedRun → its jobs are triaged again).
//
// A re-run spends the customer's CI minutes and can deploy, so it's guarded:
// - only for a workflow still selected for the repo (SPEC §2.1);
// - at most once per run (claimed in the database before GitHub is asked);
// - never for a workflow in which any job declares `environment:`, read from the workflow file at
//   the failing commit (unreadable or unparseable: no re-run) and remembered on RepoWorkflow.
import type { Db } from "@pipeheal/db";
import { forSystem } from "@pipeheal/db";
import { GitHubApiError, GuardError, type GitHubApp } from "@pipeheal/github";
import type { Logger } from "@pipeheal/shared/logger";
import type { FailureTarget } from "./triage";
import { parseWorkflowYaml } from "./workflow-yaml";

export interface FlakyCheckDeps {
  db: Db;
  githubApp: GitHubApp | null;
  /**
   * Policy `retryBeforeHeal` (SPEC §8.3). The policy engine (Phase 3) will supply the effective
   * value per repository; until then every repository has the default.
   */
  retryBeforeHeal?: boolean;
}

/** Policy `retryBeforeHeal`'s default (SPEC §8.3). */
export const RETRY_BEFORE_HEAL_DEFAULT = true;

const FAILED = new Set(["failure", "timed_out"]);

/** Re-runs the failure's failed runs that may be re-run. Safe to repeat. */
export async function checkFlaky(
  deps: FlakyCheckDeps,
  target: FailureTarget,
  log: Logger,
): Promise<void> {
  if (!(deps.retryBeforeHeal ?? RETRY_BEFORE_HEAL_DEFAULT)) return;
  const system = await forSystem(deps.db, target.orgId, "flaky-check");
  const failure = await system.failures.get(target.failureId);
  // Only a triaged failure: not one already FLAKY, dispatched or past that.
  if (failure?.status !== "TRIAGED") return;
  const candidates = failure.runs.filter((run) => !run.rerunByUs && FAILED.has(run.conclusion));
  if (candidates.length === 0) return;
  const repo = await system.repositories.get(failure.repoId);
  if (repo === null) return;
  if (deps.githubApp === null) {
    log.warn("GitHub App isn't configured; skipping the flaky check");
    return;
  }
  const client = (await deps.githubApp.installation(target.installationId)).repo(repo.fullName);
  const workflows = new Map(
    (await system.workflows.listForRepo(repo.id)).map((w) => [w.githubWorkflowId, w]),
  );

  for (const run of candidates) {
    const skip = (reason: string) => {
      log.info({ runId: String(run.runId), reason }, "flaky check: no re-run");
    };
    const workflow = workflows.get(run.workflowId);
    if (workflow?.selected !== true) {
      skip("workflow not watched");
      continue;
    }
    if (workflow.usesEnvironment) {
      skip("workflow uses an environment");
      continue;
    }
    // The workflow as it ran, at the failing commit: a branch can add `environment:`.
    const file = await client.getFileAtRef(run.workflowPath, failure.headSha);
    const facts = file?.kind === "text" ? parseWorkflowYaml(file.content) : null;
    if (facts === null) {
      skip("workflow file unreadable");
      continue;
    }
    if (facts.usesEnvironment) {
      // Remembered for the repository (a later sync from the default branch can clear it).
      await system.workflows.syncInstalled(repo.id, [
        {
          githubWorkflowId: workflow.githubWorkflowId,
          path: workflow.path,
          name: workflow.name,
          usesEnvironment: true,
        },
      ]);
      skip("workflow uses an environment");
      continue;
    }

    const claimed = await system.failures.claimRerun(run.id);
    if (claimed === null) continue;
    try {
      await client.rerunFailedJobs(run.runId);
      log.info(
        { runId: String(run.runId), fromAttempt: claimed.rerunFromAttempt },
        "flaky check: failed jobs re-run",
      );
    } catch (error) {
      // The claim stays: not knowing whether GitHub started a re-run, never ask twice. The
      // failure goes on without a flaky check.
      if (!(error instanceof GitHubApiError) && !(error instanceof GuardError)) throw error;
      log.warn({ err: error, runId: String(run.runId) }, "flaky check: re-run refused");
    }
  }
}
