// Product invariants (CLAUDE.md), enforced in the GitHub client itself, below the policy engine:
// whatever calls these wrappers, the App can only write to its own `pipeheal/*` branches, never
// force-pushes, never touches `.github/`, and has no way to merge. Repo paths are POSIX strings.

export class GuardError extends Error {
  override readonly name = "GuardError";
}

/** Branches the App creates and writes to (SPEC §9). */
export const HEAL_BRANCH_PREFIX = "pipeheal/";

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
  const segments = path.split("/");
  const invalid =
    path.length === 0 ||
    path.length > 4096 ||
    path.includes("\\") ||
    /^[A-Za-z]:/.test(path) ||
    hasControlCharacter(path) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..");
  if (invalid) throw new GuardError("not a repository-relative POSIX path");
}

/**
 * A path the App may write: never under `.github/` (INV-GITHUB-DIR; GitHub itself only blocks
 * `.github/workflows/` for Apps without the Workflows permission) and never inside `.git/`.
 * Compared case-insensitively: checkouts on Windows and macOS are case-insensitive.
 */
export function assertWritablePath(path: string): void {
  assertRepoPath(path);
  const [first = ""] = path.toLowerCase().split("/");
  if (first === ".github" || first === ".git") {
    throw new GuardError("the App never writes under .github/ or .git/");
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
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
