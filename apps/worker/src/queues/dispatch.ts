// The dispatcher (SPEC §2 steps 6-7, P4.8): a triaged failure that is healable, in scope and
// within its caps gets a HealAttempt, then the healer workflow is dispatched on the default branch
// with the attempt's ID and the failing commit. The run GitHub returns is recorded on the attempt;
// only that run can open its session (§5.4, D16).
// - It waits while a flaky re-run of ours hasn't reported (the re-run's result triggers triage,
//   the flaky check and this job again; a re-run that never reports is the §2.2 reconciler's).
// - Caps (D18) are checked by the database claim, atomically with creating the attempt. A busy
//   repository (an attempt in flight) makes the job wait and look again.
// - The dispatch call is never retried: not knowing whether GitHub started a run, the attempt
//   fails rather than risk two healer runs. No run ID back: the attempt fails too (no runner
//   could open its session).
import { forSystem, type Db, type SystemScope } from "@pipeheal/db";
import { GitHubApiError, GuardError, type GitHubApp } from "@pipeheal/github";
import { effectivePolicy } from "@pipeheal/policy";
import type { Logger } from "@pipeheal/shared/logger";
import { dispatchDecision } from "../dispatch-decision";
import { HEALER_WORKFLOW_PATH } from "../gateway/oidc";
import type { FailureTarget } from "./triage";

/** Heal attempts an organization may start in any 24 hours (D18; configurable later). */
export const MAX_ATTEMPTS_PER_DAY = 20;

export interface DispatchDeps {
  db: Db;
  githubApp: GitHubApp | null;
  /** HEAL_DISPATCH: no healer run starts unless true. */
  dispatchEnabled?: boolean;
}

/** What the job did: "busy" asks the queue to look again later. */
export type DispatchOutcome =
  "dispatched" | "settled" | "busy" | "waiting" | "capped" | "failed" | "nothing";

export async function dispatchFailure(
  deps: DispatchDeps,
  target: FailureTarget,
  log: Logger,
): Promise<DispatchOutcome> {
  const system = await forSystem(deps.db, target.orgId, "dispatcher");
  const failure = await system.failures.get(target.failureId);
  if (failure?.status !== "TRIAGED") return "nothing";
  // A re-run of ours hasn't reported yet: its result decides between FLAKY and healing.
  if (failure.runs.some((run) => run.rerunByUs && run.rerunFromAttempt === run.runAttempt)) {
    log.info("dispatch waits for the flaky re-run");
    return "waiting";
  }
  const repo = await system.repositories.get(failure.repoId);
  if (
    system.org.status !== "ACTIVE" ||
    repo === null ||
    !repo.enabled ||
    repo.removedFromInstallationAt !== null
  ) {
    return "nothing";
  }

  const { policy } = effectivePolicy(await system.policies.layers(repo.id));
  const decision = dispatchDecision(
    {
      category: failure.category,
      headBranch: failure.headBranch,
      runs: failure.runs,
      commands: repo.commands,
      workflows: await system.workflows.listForRepo(repo.id),
    },
    policy,
  );
  if (decision.kind === "settle") {
    await system.failures.settle(failure.id, { status: decision.status, reason: decision.reason });
    log.info({ status: decision.status, reason: decision.reason }, "failure not dispatched");
    return "settled";
  }
  const { githubApp } = deps;
  if (githubApp === null) {
    log.warn("GitHub App isn't configured; skipping the dispatch");
    return "nothing";
  }
  // HEAL_DISPATCH: off until D20 is built (P4.8 review H1). The diagnosis above still stands.
  if (deps.dispatchEnabled !== true) {
    log.info("dispatch is off (HEAL_DISPATCH)");
    return "nothing";
  }

  const claim = await system.attempts.claimDispatch({
    failureId: failure.id,
    failingCheck: decision.failingCheck,
    maxAttemptsPerFailure: policy.limits.maxAttemptsPerFailure,
    maxAttemptsPerDay: MAX_ATTEMPTS_PER_DAY,
  });
  if (claim.outcome === "not_ready") return "nothing";
  if (claim.outcome === "busy") return "busy";
  if (claim.outcome === "capped") {
    await system.failures.settle(failure.id, { status: "SKIPPED", reason: claim.reason });
    log.info({ reason: claim.reason }, "failure not dispatched");
    return "capped";
  }
  return startHealerRun(githubApp, system, repo, target.installationId, claim.attempt, log);
}

/**
 * Dispatches the healer for a claimed attempt, never retried: not knowing whether GitHub started a
 * run, the attempt fails rather than risk two (see the module's header).
 */
export async function startHealerRun(
  githubApp: GitHubApp,
  system: SystemScope,
  repo: { fullName: string; defaultBranch: string },
  installationId: bigint,
  attempt: { id: string; attemptNo: number; targetSha: string },
  log: Logger,
): Promise<"dispatched" | "failed"> {
  let runId: bigint | null;
  try {
    // Inside the try: a token that can't be minted fails the attempt too, rather than leaving it
    // DISPATCHED with no run (P4.8 review M1).
    const client = (await githubApp.installation(installationId)).repo(repo.fullName);
    ({ runId } = await client.dispatchWorkflow(HEALER_WORKFLOW_PATH, repo.defaultBranch, {
      job_id: attempt.id,
      target_sha: attempt.targetSha,
    }));
  } catch (error) {
    // 404: no such workflow on the default branch; 422: it has no workflow_dispatch trigger.
    const setup = error instanceof GitHubApiError && (error.status === 404 || error.status === 422);
    await system.attempts.failDispatch(attempt.id, {
      reason: setup
        ? "GitHub couldn't dispatch the healer workflow (missing, or no workflow_dispatch trigger)"
        : "GitHub refused the healer dispatch",
      failureStatus: setup ? "NEEDS_SETUP" : "FAILED",
    });
    log.warn({ attemptId: attempt.id, err: error }, "healer dispatch failed");
    if (!(error instanceof GitHubApiError) && !(error instanceof GuardError)) throw error;
    // Rate limited: rethrown so the queue pauses the installation (P4.8 review L3).
    if (error instanceof GitHubApiError && error.retryAt !== null) throw error;
    return "failed";
  }
  if (runId === null) {
    await system.attempts.failDispatch(attempt.id, {
      reason: "GitHub didn't return the healer run",
      failureStatus: "FAILED",
    });
    log.warn({ attemptId: attempt.id }, "healer dispatch returned no run");
    return "failed";
  }
  await system.attempts.recordDispatch(attempt.id, runId);
  log.info(
    { attemptId: attempt.id, attemptNo: attempt.attemptNo, runId: String(runId) },
    "healer dispatched",
  );
  return "dispatched";
}
