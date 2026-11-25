// Repository paths, checked the way git protects checkouts (verify_path with protectNTFS and
// protectHFS), since customers check PipeHeal's branches out on Windows and macOS. Pure: shared by
// the GitHub client (which refuses to write such paths) and the policy engine (which matches globs
// against what a path *is* on those systems, so `.GitHub/x` or `GITHUB~1/x` can't slip past
// `.github/**`). Repo paths are POSIX strings; never use the platform `path` module for them.

// Code points macOS (HFS+) ignores in file names, so ".git‌" is ".git" there.
const HFS_IGNORABLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\ufeff]/;
const HFS_IGNORABLE_ALL = new RegExp(HFS_IGNORABLE.source, "g");
// Names Windows reserves (any extension), and characters it refuses.
const WINDOWS_RESERVED =
  /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i;
const WINDOWS_INVALID_CHARS = /[<>:"|?*]/;
const GITHUB_DIR = /^(\.github|github~\d+)$/i;
const GIT_NAME = /^(\.git|git~\d+|\.gitmodules)$/i;

export const MAX_REPO_PATH_LENGTH = 4096;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Why `path` isn't a repo-relative POSIX path safe to name in an API call (traversal, absolute or
 * Windows paths, control characters), or null when it is one.
 */
export function repoPathProblem(path: string): string | null {
  const segments = path.split("/");
  const invalid =
    path.length === 0 ||
    path.length > MAX_REPO_PATH_LENGTH ||
    path.includes("\\") ||
    /^[A-Za-z]:/.test(path) ||
    hasControlCharacter(path) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..");
  return invalid ? "not a repository-relative POSIX path" : null;
}

/**
 * Why the App may not write `path`, or null when it may:
 * - never under `.github/` (INV-GITHUB-DIR; GitHub itself only blocks `.github/workflows/` for
 *   Apps without the Workflows permission), including its Windows 8.3 alias `GITHUB~1`;
 * - never a `.git` directory or `.gitmodules` file, at any depth;
 * - no name Windows can't check out (reserved names, trailing dot or space, `<>:"|?*`), and no
 *   code point macOS ignores.
 * Compared case-insensitively: Windows and macOS checkouts are case-insensitive.
 */
export function writablePathProblem(path: string): string | null {
  const problem = repoPathProblem(path);
  if (problem !== null) return problem;
  const segments = path.split("/");
  if (GITHUB_DIR.test(segments[0] ?? "")) return "the App never writes under .github/";
  for (const segment of segments) {
    if (GIT_NAME.test(segment)) return "the App never writes .git or .gitmodules";
    if (
      HFS_IGNORABLE.test(segment) ||
      WINDOWS_RESERVED.test(segment) ||
      WINDOWS_INVALID_CHARS.test(segment) ||
      /[. ]$/.test(segment)
    ) {
      return "the path can't be checked out safely on Windows or macOS";
    }
  }
  return null;
}

/**
 * The file a path names on a case-insensitive Windows or macOS checkout, for matching: Unicode
 * NFC (macOS stores decomposed names), lowercase, without the code points macOS ignores, without
 * the trailing dots and spaces Windows drops, and with the 8.3 aliases of `.github` and `.git`
 * spelled out. Two paths with the same canonical form can be the same file somewhere.
 */
export function canonicalPath(path: string): string {
  return path
    .normalize("NFC")
    .replace(HFS_IGNORABLE_ALL, "")
    .toLowerCase()
    .split("/")
    .map((segment) => {
      const trimmed = segment.replace(/[. ]+$/, "");
      const name = trimmed === "" ? segment : trimmed;
      if (/^github~\d+$/.test(name)) return ".github";
      if (/^git~\d+$/.test(name)) return ".git";
      return name;
    })
    .join("/");
}
