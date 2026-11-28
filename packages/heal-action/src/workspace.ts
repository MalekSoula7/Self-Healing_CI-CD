// The checkout the agent works in (SPEC §7.2). Tool paths are repo-relative POSIX paths, checked
// again here although the gateway checked them, and checked again once resolved: nothing absolute,
// no `..`, no `.git` (in any spelling a file system folds to it), and no symlink that leads out of
// the repository or into `.git` / `.github`. Writes go through no symlink at all, never follow a
// hard link or open a special file. Git runs with the scrubbed env, without hooks or fsmonitor.
import { constants, type Stats } from "node:fs";
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { devNull } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { LIMITS } from "@pipeheal/shared/protocol";
import { canonicalPath, repoPathProblem, writablePathProblem } from "@pipeheal/shared/repo-path";
import { runCommand, type CommandResult } from "./exec";

/** A tool call the runner refuses or can't carry out: its message goes back to the model. */
export class ToolError extends Error {
  override readonly name = "ToolError";
}

export interface Workspace {
  /** The checkout's real path. */
  root: string;
  env: NodeJS.ProcessEnv;
  git(
    args: readonly string[],
    options?: { maxOutputChars?: number; keep?: "head" | "tail" },
  ): Promise<CommandResult>;
}

/** Git options that keep repository config from running code or hiding changes (review L3). */
const SAFE_GIT = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  `core.hooksPath=${devNull}`,
  "-c",
  "core.untrackedCache=false",
];

export async function openWorkspace(root: string, env: NodeJS.ProcessEnv): Promise<Workspace> {
  const real = await realpath(root);
  const gitEnv = {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_DIR: join(real, ".git"),
    GIT_WORK_TREE: real,
    GIT_CEILING_DIRECTORIES: dirname(real),
  };
  return {
    root: real,
    env,
    git: (args, options = {}) =>
      runCommand(["git", ...SAFE_GIT, ...args], {
        cwd: real,
        env: gitEnv,
        timeoutMs: 60_000,
        maxOutputChars: options.maxOutputChars ?? LIMITS.toolOutputChars,
        keep: options.keep ?? "tail",
      }),
  };
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** `.git` in any spelling a file system can fold to it (`.GIT`, `GIT~1`, ignorable code points). */
function namesGit(repoPath: string): boolean {
  return canonicalPath(repoPath).split("/").includes(".git");
}

function check(repoPath: string, write: boolean, shown: string): void {
  const problem = write ? writablePathProblem(repoPath) : repoPathProblem(repoPath);
  if (problem !== null) throw new ToolError(`${shown}: ${problem}`);
  if (namesGit(repoPath)) throw new ToolError(`${shown}: the .git directory is off limits`);
}

/**
 * The OS path of a repo path, inside the checkout. The path is checked as written and again as
 * resolved, so a link can't lead out of the checkout, into `.git`, or (for writes) anywhere the
 * App never writes. Writes refuse any symlink along the way.
 */
export async function resolvePath(
  workspace: Workspace,
  repoPath: string,
  options: { write: boolean },
): Promise<string> {
  if (repoPath === "." && !options.write) return workspace.root;
  check(repoPath, options.write, repoPath);
  const segments = repoPath.split("/");
  const target = join(workspace.root, ...segments);
  // Every existing part along the way: no link for a write; for a read, its real place counts.
  let existing = workspace.root;
  let rest: string[] = segments;
  for (const [index, segment] of segments.entries()) {
    const next = join(existing, segment);
    const info = await lstatOrNull(next);
    if (info === null) break;
    if (options.write && info.isSymbolicLink()) {
      throw new ToolError(`${repoPath}: won't write through a symlink`);
    }
    existing = next;
    rest = segments.slice(index + 1);
  }
  const real = await realpath(existing);
  if (!inside(workspace.root, real)) {
    throw new ToolError(`${repoPath}: the path leads out of the repository`);
  }
  const resolved = [
    relative(workspace.root, real)
      .split(sep)
      .filter((part) => part !== ""),
    rest,
  ]
    .flat()
    .join("/");
  if (resolved !== "" && resolved !== repoPath) check(resolved, options.write, repoPath);
  return target;
}

export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** A regular file's text, its size checked before it is read (review L2). */
export async function readBoundedText(path: string, shown: string, max: number): Promise<string> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new ToolError(`${shown}: no such file`);
  if (info.size > max) throw new ToolError(`${shown}: larger than ${String(max)} bytes`);
  const buffer = await readFile(path);
  if (buffer.includes(0)) throw new ToolError(`${shown}: a binary file`);
  return buffer.toString("utf8");
}

/**
 * Writes a regular file without following a link at its last component, and refuses one with
 * other hard links (it could be a file outside the checkout) or that isn't a regular file.
 */
export async function writeRegularFile(
  path: string,
  shown: string,
  content: string,
): Promise<void> {
  const info = await lstatOrNull(path);
  if (info !== null && (!info.isFile() || info.nlink > 1)) {
    throw new ToolError(`${shown}: not a plain file`);
  }
  // Not on Windows, where the symlink check along the path (resolvePath) is what holds.
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollow,
    0o644,
  );
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

/** Untracked files count as changes: git only diffs what it knows, so mark them intended. */
async function addIntent(workspace: Workspace, paths?: readonly string[]): Promise<void> {
  await workspace.git(
    paths === undefined
      ? ["add", "--intent-to-add", "--all"]
      : ["add", "--intent-to-add", "--", ...paths],
  );
}

/** The working tree against the checked-out commit, as one `git diff` (SPEC §7.2). */
export async function cumulativeDiff(
  workspace: Workspace,
  touched: ReadonlySet<string>,
): Promise<{ diff: string; truncated: boolean }> {
  if (touched.size > 0) await addIntent(workspace, [...touched]);
  // The start, not the end: a diff cut at its start can't be parsed.
  const result = await workspace.git(
    ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "HEAD"],
    { maxOutputChars: LIMITS.toolOutputChars, keep: "head" },
  );
  return { diff: result.output, truncated: result.truncated };
}

/** Every tracked file, for the model's file tree (the gateway keeps the top of it). */
export async function trackedFiles(workspace: Workspace): Promise<string[]> {
  const result = await workspace.git(["ls-files", "-z"], {
    maxOutputChars: 4_000_000,
    keep: "head",
  });
  const paths = result.output.split("\0");
  // A cut list ends in a partial path: drop it.
  if (result.truncated) paths.pop();
  return paths
    .filter((path) => path !== "" && repoPathProblem(path) === null)
    .slice(0, LIMITS.fileTreeEntries);
}
