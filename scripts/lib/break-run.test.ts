// Runs real git against throwaway repositories in the OS temp directory.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { breakRepo, git } from "./break-run";
import { ScenarioError, findScenario, type Scenario } from "./break-scenarios";

const SELF_REPO = fileURLToPath(new URL("../..", import.meta.url));
const NOW = new Date("2026-09-28T12:34:56Z");

function scenario(id: string): Scenario {
  const found = findScenario(id);
  if (found === undefined) throw new Error(`test setup: no scenario ${id}`);
  return found;
}

let tmp: string;
let repo: string;

/** A fresh clone-like repo of the node demo, one commit on `main`. */
function createDemoRepo(dir: string): void {
  cpSync(fileURLToPath(new URL("../../examples/demo-node", import.meta.url)), dir, {
    recursive: true,
    filter: (source) => !/[\\/](node_modules|reports)([\\/]|$)/.test(source),
  });
  git(["init", "--quiet", "--initial-branch", "main"], dir);
  const config: [string, string][] = [
    ["user.name", "Test"],
    ["user.email", "test@example.test"],
    ["commit.gpgsign", "false"],
  ];
  for (const [key, value] of config) {
    git(["config", key, value], dir);
  }
  git(["add", "--all"], dir);
  git(["commit", "--quiet", "--message", "Initial commit"], dir);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pipeheal-break-"));
  repo = join(tmp, "demo-node");
  createDemoRepo(repo);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("breakRepo", () => {
  it("commits the scenario on a new branch and returns to the original branch", () => {
    const result = breakRepo(scenario("node/type-error"), {
      repo,
      selfRepo: SELF_REPO,
      push: false,
      now: NOW,
    });

    expect(result).toEqual({
      branch: "break/type-error-20260928-123456",
      changed: ["src/cart.ts"],
      pushed: false,
    });
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], repo)).toBe("main");
    expect(readFileSync(join(repo, "src", "cart.ts"), "utf8")).toContain("function lineTotal(");
    expect(git(["log", "--format=%s", "main..break/type-error-20260928-123456"], repo)).toBe(
      "Rename lineTotal to lineItemTotal",
    );
    expect(git(["diff", "--name-only", "main", result.branch], repo)).toBe("src/cart.ts");
    expect(git(["show", `${result.branch}:src/cart.ts`], repo)).toContain(
      "function lineItemTotal(",
    );
  });

  it("pushes the branch when asked", () => {
    const remote = join(tmp, "origin.git");
    git(["init", "--quiet", "--bare", remote], tmp);
    git(["remote", "add", "origin", remote], repo);

    const result = breakRepo(scenario("node/missing-secret"), {
      repo,
      selfRepo: SELF_REPO,
      push: true,
      now: NOW,
    });

    expect(result.pushed).toBe(true);
    expect(git(["branch", "--list", "--format=%(refname:short)"], remote)).toContain(result.branch);
  });

  it("returns to the original branch even when the push fails, keeping the commit", () => {
    expect(() =>
      breakRepo(scenario("node/lint"), { repo, selfRepo: SELF_REPO, push: true, now: NOW }),
    ).toThrow(ScenarioError);

    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], repo)).toBe("main");
    expect(git(["log", "--format=%s", "-1", "break/lint-20260928-123456"], repo)).toBe(
      "Track the item count in subtotal",
    );
  });

  it("leaves no branch behind when the scenario doesn't apply", () => {
    writeFileSync(join(repo, "src", "cart.ts"), "export {};\n");
    git(["commit", "--quiet", "--all", "--message", "Rewrite cart"], repo);

    expect(() =>
      breakRepo(scenario("node/type-error"), { repo, selfRepo: SELF_REPO, push: false, now: NOW }),
    ).toThrow(/exactly once/);

    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], repo)).toBe("main");
    expect(git(["branch", "--list", "break/*"], repo)).toBe("");
  });

  it("refuses a clone with uncommitted changes", () => {
    writeFileSync(join(repo, "notes.txt"), "wip\n");

    expect(() =>
      breakRepo(scenario("node/lint"), { repo, selfRepo: SELF_REPO, push: false }),
    ).toThrow(/uncommitted changes/);
  });

  it("refuses the other demo's scenarios", () => {
    expect(() =>
      breakRepo(scenario("python/lint"), { repo, selfRepo: SELF_REPO, push: false }),
    ).toThrow(/python demo/);
  });

  it("refuses a folder that isn't the root of a repository", () => {
    expect(() =>
      breakRepo(scenario("node/lint"), {
        repo: join(repo, "src"),
        selfRepo: SELF_REPO,
        push: false,
      }),
    ).toThrow(/root of a git repository/);
  });

  it("refuses to touch this PipeHeal repository, demo copy in examples/ included", () => {
    expect(() =>
      breakRepo(scenario("node/lint"), { repo: SELF_REPO, selfRepo: SELF_REPO, push: false }),
    ).toThrow(/this PipeHeal repository/);
    expect(() =>
      breakRepo(scenario("node/lint"), {
        repo: join(SELF_REPO, "examples", "demo-node"),
        selfRepo: SELF_REPO,
        push: false,
      }),
    ).toThrow(ScenarioError);
  });
});
