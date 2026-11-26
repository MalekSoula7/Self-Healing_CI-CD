import { describe, expect, it } from "vitest";
import { canonicalPath, repoPathProblem, writablePathProblem } from "./repo-path";

// assertRepoPath / assertWritablePath (packages/github) wrap these; their cases live in
// packages/github/src/guards.test.ts. Here: the problems themselves and the canonical form.
describe("repoPathProblem and writablePathProblem", () => {
  it("names the problem, or returns null", () => {
    expect(repoPathProblem("src/a.ts")).toBeNull();
    expect(repoPathProblem("../a")).toBe("not a repository-relative POSIX path");
    expect(writablePathProblem("src/a.ts")).toBeNull();
    expect(writablePathProblem("../a")).toBe("not a repository-relative POSIX path");
    expect(writablePathProblem(".github/x")).toBe("the App never writes under .github/");
    expect(writablePathProblem(".gıthub/x")).toBe("the App never writes under .github/");
    expect(writablePathProblem(".PipeHeal.yml")).toBe("the App never writes .pipeheal.yml");
    expect(writablePathProblem("docs/.pipeheal.yml")).toBeNull();
    expect(repoPathProblem(`src/${"a".repeat(256)}`)).toBe("not a repository-relative POSIX path");
    expect(writablePathProblem("a/.git/x")).toBe("the App never writes .git or .gitmodules");
    expect(writablePathProblem("config/ENV~1")).toBe(
      "the path can't be checked out safely on Windows or macOS",
    );
    expect(writablePathProblem("a/nul.txt")).toBe(
      "the path can't be checked out safely on Windows or macOS",
    );
  });
});

describe("canonicalPath", () => {
  it.each([
    ["src/Index.TS", "src/index.ts"],
    [".GitHub/workflows/ci.yml", ".github/workflows/ci.yml"],
    ["GITHUB~1/workflows/ci.yml", ".github/workflows/ci.yml"],
    [".github./workflows/ci.yml", ".github/workflows/ci.yml"],
    [".github /workflows/ci.yml", ".github/workflows/ci.yml"],
    [".git\u200c/config", ".git/config"],
    ["vendor/GIT~1/config", "vendor/.git/config"],
    [".e\u0301nv", ".env"],
    [".g\u0131thub/x", ".github/x"],
    ["config/\u017fecrets/a", "config/secrets/a"],
    ["./src//a/../b", "src/b"],
    ["src\\a.ts", "src/a.ts"],
    ["secrets\ufeff/a.key", "secrets/a.key"],
    ["a/.../b", "a/.../b"],
    ["src/a.ts", "src/a.ts"],
  ])("%j is %j", (path, canonical) => {
    expect(canonicalPath(path)).toBe(canonical);
  });
});
