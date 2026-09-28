// `workflow_run` completed (SPEC §2 steps 2 and 4, §2.1): filters the run, then attaches a failed
// run to its commit's failure, records a re-run that passed, and closes the collection window
// early once every watched run of the commit has completed. Checks that need no GitHub call run
// first: most events (successful runs of commits that never failed) cost none.
import {
  forSystem,
  installations,
  type PipelineFailure,
  type RepoWorkflow,
  type Repository,
  type SystemScope,
} from "@pipeheal/db";
import {
  HEALER_WORKFLOW_PATH,
  isHealBranch,
  type RepoClient,
  type WorkflowRunEvent,
} from "@pipeheal/github";
import type { Logger } from "@pipeheal/shared/logger";
import type { WebhookProcessorDeps } from "./webhooks";
import { syncRepoWorkflows } from "./workflow-sync";

const FAILED = new Set(["failure", "timed_out"]);

/** The watched workflow the run belongs to; a workflow we don't know yet is discovered first. */
async function watchedWorkflow(
  system: SystemScope,
  repo: Repository,
  workflowId: bigint,
  discover: () => Promise<void>,
): Promise<RepoWorkflow | null> {
  const find = async () =>
    (await system.workflows.listForRepo(repo.id)).find((w) => w.githubWorkflowId === workflowId);
  let workflow = await find();
  if (workflow === undefined) {
    await discover();
    workflow = await find();
  }
  return workflow?.selected === true ? workflow : null;
}

/**
 * SPEC §2.1: the window closes early once every watched run of the commit has completed; triage
 * starts then (SPEC §2 step 5).
 */
async function closeWindowIfComplete(
  system: SystemScope,
  repoClient: RepoClient,
  repo: Repository,
  failure: PipelineFailure,
  startTriage: () => Promise<void>,
  log: Logger,
): Promise<void> {
  if (failure.windowClosedAt !== null) return;
  const watched = new Set(
    (await system.workflows.listForRepo(repo.id))
      .filter((workflow) => workflow.selected)
      .map((workflow) => workflow.githubWorkflowId),
  );
  const runs = (await repoClient.listRunsForSha(failure.headSha)).filter(
    (run) => watched.has(run.workflowId) && !run.fromFork,
  );
  if (runs.length > 0 && runs.every((run) => run.status === "completed")) {
    await system.failures.closeWindow(failure.id);
    log.info(
      { failureId: failure.id },
      "collection window closed early: every watched run completed",
    );
    await startTriage();
  }
}

interface Target {
  orgId: string;
  system: SystemScope;
  repo: Repository;
}

/** SPEC §2 step 4's filters that need no GitHub call: the run's org and repo, or why it's ignored. */
async function resolveTarget(
  deps: WebhookProcessorDeps,
  event: WorkflowRunEvent,
): Promise<Target | string> {
  const run = event.workflow_run;
  if (event.action !== "completed") return `action ${event.action}`;
  // Fail closed (CLAUDE.md): code that didn't come from the repository itself is never ours.
  if (run.fromFork) return "from a fork";
  // Runs on PipeHeal's own branches belong to an attempt (P5.3), never to a new failure.
  if (run.headBranch !== null && isHealBranch(run.headBranch)) return "PipeHeal branch";
  if (run.path === HEALER_WORKFLOW_PATH) return "the healer workflow";

  const org = await installations(deps.db, "webhook").findByInstallationId(event.installation.id);
  if (org === null) return "unknown installation";
  if (org.status !== "ACTIVE") return `organization ${org.status.toLowerCase()}`;
  const system = await forSystem(deps.db, org.id, "webhook");
  const repo = await system.repositories.findByGithubId(event.repository.id);
  if (repo === null || !repo.enabled || repo.removedFromInstallationAt !== null) {
    return "repository not enabled";
  }
  return { orgId: org.id, system, repo };
}

export async function processWorkflowRunEvent(
  deps: WebhookProcessorDeps,
  event: WorkflowRunEvent,
  log: Logger,
): Promise<void> {
  const run = event.workflow_run;
  const ignore = (reason: string) => {
    log.info({ runId: String(run.id), reason }, "workflow_run ignored");
  };
  const target = await resolveTarget(deps, event);
  if (typeof target === "string") {
    ignore(target);
    return;
  }
  const { orgId, system, repo } = target;
  const failed = run.conclusion !== null && FAILED.has(run.conclusion);
  const existing = failed ? null : await system.failures.findBySha(repo.id, run.headSha);
  // A run that passed or was cancelled only matters to a failure of the same commit.
  if (!failed && existing === null) return;

  const { githubApp } = deps;
  if (githubApp === null) {
    log.warn("GitHub App isn't configured; skipping workflow_run");
    return;
  }
  const repoClient = (await githubApp.installation(event.installation.id)).repo(repo.fullName);
  const workflow = await watchedWorkflow(system, repo, run.workflowId, () =>
    syncRepoWorkflows(system, repoClient, repo, log),
  );
  if (workflow === null) {
    ignore("workflow not watched");
    return;
  }

  if (failed) {
    const jobs = await repoClient.listFailedJobs(run.id, run.runAttempt);
    const { failure, outcome } = await system.failures.recordFailedRun(repo.id, {
      headSha: run.headSha,
      headBranch: run.headBranch,
      runId: run.id,
      runAttempt: run.runAttempt,
      workflowId: run.workflowId,
      workflowName: run.name ?? workflow.name,
      workflowPath: run.path,
      conclusion: run.conclusion === "timed_out" ? "timed_out" : "failure",
      htmlUrl: run.htmlUrl,
      jobs: jobs.map((job) => ({
        githubJobId: job.id,
        name: job.name,
        failedStep: job.failedStep,
        htmlUrl: job.htmlUrl,
      })),
    });
    log.info({ failureId: failure.id, outcome, runId: String(run.id) }, "failed run recorded");
    const next = { orgId, failureId: failure.id, installationId: event.installation.id };
    if (failure.windowClosedAt === null) {
      // Every time, not only when opened: a retried job must still get its timer (idempotent).
      await deps.failureJobs.scheduleWindowClose(next, failure.windowClosesAt);
      await closeWindowIfComplete(
        system,
        repoClient,
        repo,
        failure,
        () => deps.failureJobs.enqueueTriage(next),
        log,
      );
    } else if (outcome !== "unchanged") {
      // Attached after the window closed (a late arrival, or a newer failed attempt): its jobs
      // still need triage (SPEC §2.1).
      await deps.failureJobs.enqueueTriage(next, `${String(run.id)}-${String(run.runAttempt)}`);
    }
    return;
  }

  if (run.conclusion === "success") {
    const passed = await system.failures.recordPassedRun(repo.id, {
      runId: run.id,
      runAttempt: run.runAttempt,
    });
    if (passed !== null) {
      log.info({ failureId: passed.failure.id, outcome: passed.outcome }, "re-run passed");
    }
  }
  if (existing !== null) {
    const next = { orgId, failureId: existing.id, installationId: event.installation.id };
    await closeWindowIfComplete(
      system,
      repoClient,
      repo,
      existing,
      () => deps.failureJobs.enqueueTriage(next),
      log,
    );
  }
}
