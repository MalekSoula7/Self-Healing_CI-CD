// Applies one eval scenario to a clone of a demo repo: a new branch from the current commit, one
// ordinary-looking commit, optionally pushed, then back to the branch the clone was on.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  DEMO_MARKERS,
  ScenarioError,
  applyEdits,
  type RepoFiles,
  type Scenario,
} from "./break-scenarios";

export type Git = (args: readonly string[], cwd: string) => string;

export const git: Git = (args, cwd) => {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : "";
    throw new ScenarioError(
      `git ${args[0] ?? ""} failed in ${cwd}: ${stderr.trim() || String(error)}`,
    );
  }
};

/** Filesystem paths, compared the way the OS does (case-insensitive on Windows). */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const resolved = resolve(p);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

function repoFiles(root: string): RepoFiles {
  // Repo paths are POSIX; only here do they become filesystem paths.
  const at = (path: string) => join(root, ...path.split("/"));
  return {
    read: (path) => (existsSync(at(path)) ? readFileSync(at(path), "utf8") : null),
    write: (path, content) => {
      mkdirSync(dirname(at(path)), { recursive: true });
      writeFileSync(at(path), content);
    },
  };
}

export interface BreakOptions {
  /** Path to the root of a clone of the scenario's demo repo. */
  repo: string;
  /** The repository this script belongs to: the demo inside it must never be the target. */
  selfRepo: string;
  push: boolean;
  /** For the branch name; tests pin it. */
  now?: Date;
  git?: Git;
}

export interface BreakResult {
  branch: string;
  changed: string[];
  pushed: boolean;
}

function timestamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

export function breakRepo(scenario: Scenario, options: BreakOptions): BreakResult {
  const run = options.git ?? git;
  const repo = resolve(options.repo);
  const toplevel = run(["rev-parse", "--show-toplevel"], repo);
  if (!samePath(toplevel, repo)) {
    throw new ScenarioError(
      `--repo must be the root of a git repository (that one is ${toplevel})`,
    );
  }
  if (samePath(toplevel, run(["rev-parse", "--show-toplevel"], options.selfRepo))) {
    throw new ScenarioError(
      "--repo is this PipeHeal repository. Copy the demo into its own repository first " +
        "(examples/README.md).",
    );
  }
  const files = repoFiles(repo);
  const marker = DEMO_MARKERS[scenario.demo];
  if (!(files.read(marker.path) ?? "").includes(marker.contains)) {
    throw new ScenarioError(`${scenario.id} needs a clone of the ${scenario.demo} demo repo`);
  }
  if (run(["status", "--porcelain"], repo) !== "") {
    throw new ScenarioError("the demo repo has uncommitted changes: commit or stash them first");
  }

  const original = run(["rev-parse", "--abbrev-ref", "HEAD"], repo);
  const name = scenario.id.slice(scenario.id.indexOf("/") + 1);
  const branch = `break/${name}-${timestamp(options.now ?? new Date())}`;
  run(["switch", "--create", branch], repo);
  let changed: string[];
  try {
    changed = applyEdits(files, scenario.edits);
  } catch (error) {
    // applyEdits wrote nothing: drop the empty branch this call just created.
    run(["switch", original], repo);
    run(["branch", "--delete", branch], repo);
    throw error;
  }
  try {
    run(["add", "--", ...changed], repo);
    run(["commit", "--quiet", "--message", scenario.commitMessage], repo);
    if (options.push) run(["push", "--quiet", "--set-upstream", "origin", branch], repo);
  } finally {
    // Even if the push fails: the commit stays on its branch, and the clone is back where it was.
    run(["switch", original], repo);
  }
  return { branch, changed, pushed: options.push };
}
