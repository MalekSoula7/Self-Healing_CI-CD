// Recent changes of a failure (SPEC §6.2 step 7), once triage has run: find the last green
// commit of each failing workflow (same branch first, then the default branch), compare it with
// the failing commit, and store what changed, redacted and cut to a token budget, files named by
// the failure's signals first. Without any green run, the default branch's tip serves as the
// base: GitHub's three-dot comparison then starts at the merge base.
import { selectRecentChanges, signalPaths, type SignalPathSources } from "@pipeheal/agent-core";
import { forSystem, jobSignalsSchema, type Db, type RecentChangesRecord } from "@pipeheal/db";
import {
  GitHubApiError,
  GuardError,
  type Comparison,
  type GitHubApp,
  type RepoClient,
} from "@pipeheal/github";
import type { Logger } from "@pipeheal/shared/logger";
import type { FailureTarget } from "./triage";

export interface RecentChangesDeps {
  db: Db;
  githubApp: GitHubApp | null;
}

/** Green runs looked at per branch, and comparisons tried among them. */
const CANDIDATE_RUNS = 10;
const MAX_COMPARES_PER_BRANCH = 3;

type Base = Extract<RecentChangesRecord, { base: object }>["base"];
interface Found {
  base: Base;
  comparison: Comparison;
}

/**
 * The failing commit compared with `baseSha`, if `baseSha` comes before it: "ahead" (the base
 * is an ancestor) or "diverged" (the comparison starts at their merge base). A base after the
 * failing commit ("behind"), the commit itself, or a commit GitHub doesn't know (deleted,
 * force-pushed away) isn't one.
 */
async function compareFrom(
  repo: RepoClient,
  baseSha: string,
  headSha: string,
): Promise<Comparison | null> {
  if (baseSha === headSha) return null;
  try {
    const comparison = await repo.compareCommits(baseSha, headSha);
    return comparison.status === "ahead" || comparison.status === "diverged" ? comparison : null;
  } catch (error) {
    if (error instanceof GitHubApiError && (error.status === 404 || error.status === 422)) {
      return null;
    }
    throw error;
  }
}

/** The workflow's last green run on `branch` that comes before the failing commit. */
async function lastGreenOn(
  repo: RepoClient,
  workflowId: bigint,
  branch: string,
  headSha: string,
  source: Base["source"],
): Promise<Found | null> {
  let runs;
  try {
    runs = await repo.listSuccessfulRuns(workflowId, branch, CANDIDATE_RUNS);
  } catch (error) {
    // A branch name GitHub accepts but our guard doesn't: no same-branch base, try the next.
    if (error instanceof GuardError) return null;
    throw error;
  }
  let compares = 0;
  for (const run of runs) {
    if (run.headSha === headSha) continue;
    if (compares === MAX_COMPARES_PER_BRANCH) break;
    compares += 1;
    const comparison = await compareFrom(repo, run.headSha, headSha);
    if (comparison !== null) {
      return { base: { sha: run.headSha, source, branch, runId: String(run.id) }, comparison };
    }
  }
  return null;
}

/** Finds the base and the comparison for one failure. Null when there's nothing to compare. */
async function findBase(
  repo: RepoClient,
  failure: { headSha: string; headBranch: string | null; workflowIds: bigint[] },
  defaultBranch: string,
): Promise<Found | null> {
  const found: Found[] = [];
  for (const workflowId of failure.workflowIds) {
    const sameBranch =
      failure.headBranch === null
        ? null
        : await lastGreenOn(repo, workflowId, failure.headBranch, failure.headSha, "same-branch");
    const result =
      sameBranch ??
      (failure.headBranch === defaultBranch
        ? null
        : await lastGreenOn(repo, workflowId, defaultBranch, failure.headSha, "default-branch"));
    if (result !== null) found.push(result);
  }
  // Several failing workflows: the comparison with the most commits covers all their changes.
  const widest = found.reduce<Found | null>(
    (best, next) =>
      best === null || next.comparison.totalCommits > best.comparison.totalCommits ? next : best,
    null,
  );
  if (widest !== null) return widest;

  // No green run at all (a new workflow, or a repository that has never passed): what the branch
  // changed since it left the default branch.
  const tip = await repo.getBranchSha(defaultBranch);
  if (tip === null) return null;
  const comparison = await compareFrom(repo, tip, failure.headSha);
  return comparison === null
    ? null
    : { base: { sha: tip, source: "merge-base", branch: defaultBranch, runId: null }, comparison };
}

/** Resolves and stores the failure's recent changes, once. Safe to repeat. */
export async function resolveRecentChanges(
  deps: RecentChangesDeps,
  target: FailureTarget,
  log: Logger,
): Promise<void> {
  const system = await forSystem(deps.db, target.orgId, "recent-changes");
  const failure = await system.failures.get(target.failureId);
  // Gone, or already resolved.
  if (failure?.recentChanges !== null) return;
  const repo = await system.repositories.get(failure.repoId);
  if (repo === null) return;
  if (deps.githubApp === null) {
    log.warn("GitHub App isn't configured; skipping recent changes");
    return;
  }
  const client = (await deps.githubApp.installation(target.installationId)).repo(repo.fullName);

  const failing = failure.runs.filter((run) => run.conclusion !== "success");
  const runs = failing.length > 0 ? failing : failure.runs;
  const workflowIds = [...new Set(runs.map((run) => run.workflowId))];
  const priorityPaths = signalPaths(
    mergeSignals(runs.flatMap((run) => run.jobs.map((job) => job.signals))),
  );

  const found = await findBase(
    client,
    { headSha: failure.headSha, headBranch: failure.headBranch, workflowIds },
    repo.defaultBranch,
  );
  if (found === null) {
    await system.failures.recordRecentChanges(failure.id, {
      base: null,
      reason:
        "No earlier green run of these workflows, and nothing to compare on the default branch.",
    });
    log.info("no base commit for recent changes");
    return;
  }
  const changes = selectRecentChanges(found.comparison, { priorityPaths });
  await system.failures.recordRecentChanges(failure.id, { base: found.base, changes });
  log.info(
    {
      baseSha: found.base.sha,
      source: found.base.source,
      commits: changes.totalCommits,
      files: changes.totalFiles,
      filesShown: changes.files.length,
      estimatedTokens: changes.estimatedTokens,
      redactions: changes.redactions,
    },
    "recent changes recorded",
  );
}

/** Every stored job's signals that are still valid, merged (unknown shapes are skipped). */
function mergeSignals(stored: unknown[]): SignalPathSources {
  const merged = {
    locations: [] as SignalPathSources["locations"][number][],
    diagnostics: [] as SignalPathSources["diagnostics"][number][],
    failingTests: [] as string[],
  };
  for (const raw of stored) {
    const parsed = jobSignalsSchema.safeParse(raw);
    if (!parsed.success) continue;
    merged.locations.push(...parsed.data.locations);
    merged.diagnostics.push(...parsed.data.diagnostics);
    merged.failingTests.push(...parsed.data.failingTests);
  }
  return merged;
}
