// Product invariants (CLAUDE.md), enforced in the GitHub client itself, below the policy engine:
// whatever calls these wrappers, the App can only write to its own `pipeheal/*` branches, never
// force-pushes, never touches `.github/`, and has no way to merge. Repo paths are POSIX strings.

export class GuardError extends Error {
  override readonly name = "GuardError";
}

/** Branches the App creates and writes to (SPEC §9). */
export const HEAL_BRANCH_PREFIX = "pipeheal/";

/** The healer workflow's fixed path (SPEC §5.3): its own runs are never failures to heal. */
export const HEALER_WORKFLOW_PATH = ".github/workflows/pipeheal.yml";

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

// Code points macOS (HFS+) ignores in file names, so ".git\u200c" is ".git" there.
const HFS_IGNORABLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\ufeff]/;
// Names Windows reserves (any extension), and characters it refuses.
const WINDOWS_RESERVED =
  /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i;
const WINDOWS_INVALID_CHARS = /[<>:"|?*]/;

/**
 * A path the App may write, checked the way git protects checkouts (verify_path with
 * protectNTFS and protectHFS), since customers check PipeHeal's branches out on Windows and
 * macOS:
 * - never under `.github/` (INV-GITHUB-DIR; GitHub itself only blocks `.github/workflows/` for
 *   Apps without the Workflows permission), including its Windows 8.3 alias `GITHUB~1`;
 * - never a `.git` directory or `.gitmodules` file, at any depth;
 * - no name Windows can't check out (reserved names, trailing dot or space, `<>:"|?*`), and no
 *   code point macOS ignores.
 * Compared case-insensitively: Windows and macOS checkouts are case-insensitive.
 */
export function assertWritablePath(path: string): void {
  assertRepoPath(path);
  const segments = path.split("/");
  const [first = ""] = segments;
  if (/^(\.github|github~\d+)$/i.test(first)) {
    throw new GuardError("the App never writes under .github/");
  }
  for (const segment of segments) {
    if (/^(\.git|git~\d+|\.gitmodules)$/i.test(segment)) {
      throw new GuardError("the App never writes .git or .gitmodules");
    }
    if (
      HFS_IGNORABLE.test(segment) ||
      WINDOWS_RESERVED.test(segment) ||
      WINDOWS_INVALID_CHARS.test(segment) ||
      /[. ]$/.test(segment)
    ) {
      throw new GuardError("the path can't be checked out safely on Windows or macOS");
    }
  }
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
