// Product invariants (CLAUDE.md), enforced in the GitHub client itself, below the policy engine:
// whatever calls these wrappers, the App can only write to its own `pipeheal/*` branches, never
// force-pushes, never touches `.github/`, and has no way to merge. Repo paths are POSIX strings.
import { repoPathProblem, writablePathProblem } from "@pipeheal/shared/repo-path";

export class GuardError extends Error {
  override readonly name = "GuardError";
}

/** Branches the App creates and writes to (SPEC §9). */
export const HEAL_BRANCH_PREFIX = "pipeheal/";

/** The healer workflow's fixed path (SPEC §5.3): its own runs are never failures to heal. */
export const HEALER_WORKFLOW_PATH = ".github/workflows/pipeheal.yml";

/**
 * Trigger events whose runs execute the repository's own code. `pull_request_target`,
 * `workflow_run`, `issue_comment` and the like run in the base repository's context, so their
 * head repository looks like ours even when they check out a fork's code: PipeHeal never records,
 * re-runs or heals those (CLAUDE.md: never act on forks).
 */
export const TRUSTED_RUN_EVENTS: ReadonlySet<string> = new Set([
  "push",
  "pull_request",
  "merge_group",
  "schedule",
  "workflow_dispatch",
]);

const HEAL_BRANCH = /^pipeheal\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function isHealBranch(branch: string): boolean {
  return HEAL_BRANCH.test(branch) && !branch.includes("..") && !branch.endsWith(".lock");
}

export function assertHealBranch(branch: string): void {
  if (!isHealBranch(branch)) {
    throw new GuardError("the App only writes to its own pipeheal/* branches");
  }
}

/**
 * A repo-relative POSIX path that is safe to name in an API call: no traversal, no absolute or
 * Windows paths, no control characters.
 */
export function assertRepoPath(path: string): void {
  const problem = repoPathProblem(path);
  if (problem !== null) throw new GuardError(problem);
}

/**
 * A path the App may write (`writablePathProblem` in `@pipeheal/shared/repo-path`): never under
 * `.github/` or a `.git` directory, and safe to check out on Windows and macOS.
 */
export function assertWritablePath(path: string): void {
  const problem = writablePathProblem(path);
  if (problem !== null) throw new GuardError(problem);
}

/** A branch name safe to pass to GitHub (the healer's `ref`, a PR base). */
export function assertBranchName(branch: string): void {
  const valid =
    /^[A-Za-z0-9._/-]{1,255}$/.test(branch) &&
    !branch.startsWith("-") &&
    !branch.startsWith("/") &&
    !branch.endsWith("/") &&
    !branch.endsWith(".lock") &&
    !branch.includes("..") &&
    !branch.includes("//");
  if (!valid) throw new GuardError("not a valid branch name");
}

// Commit-message markers that make GitHub Actions skip workflows for the commit.
const SKIP_CI = /\[(skip ci|ci skip|no ci|skip actions|actions skip)\]|^skip-checks:\s*true/im;

/**
 * A commit message for a fix: it must never switch off the CI run that verifies the fix
 * independently (SPEC §9.1). Messages are built from model output, so this is enforced here.
 */
export function assertCommitMessage(message: string): void {
  if (message.trim().length === 0 || message.length > 10_000) {
    throw new GuardError("a commit message must be 1 to 10000 characters");
  }
  if (SKIP_CI.test(message)) throw new GuardError("a fix's commit must not skip CI");
}

/** `owner/name` of a GitHub repository. */
export function parseFullName(fullName: string): { owner: string; repo: string } {
  const match = /^([A-Za-z0-9](?:-?[A-Za-z0-9]){0,38})\/((?!\.\.?$)[A-Za-z0-9._-]{1,100})$/.exec(
    fullName,
  );
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new GuardError("not an owner/name repository");
  }
  return { owner: match[1], repo: match[2] };
}
