import { describe, expect, it } from "vitest";
import {
  GuardError,
  assertHealBranch,
  assertRepoPath,
  assertWritablePath,
  isHealBranch,
  parseFullName,
} from "./guards";

describe("heal branches", () => {
  it.each(["pipeheal/abc123-1", "pipeheal/a.b_c-2"])("accepts %s", (branch) => {
    expect(isHealBranch(branch)).toBe(true);
  });

  it.each([
    "main",
    "feature/x",
    "pipeheal/",
    "pipeheal",
    "Pipeheal/x",
    "pipeheal/../main",
    "pipeheal/a..b",
    "pipeheal/x.lock",
    "pipeheal/a/b",
    "refs/heads/pipeheal/x",
    "pipeheal/-x",
    "pipeheal/x y",
    `pipeheal/${"a".repeat(101)}`,
  ])("refuses %s", (branch) => {
    expect(isHealBranch(branch)).toBe(false);
    expect(() => {
      assertHealBranch(branch);
    }).toThrow(GuardError);
  });
});

describe("repo paths", () => {
  it.each(["src/index.ts", "a", "docs/.github-notes.md", "src/.github/x.ts", ".githubx/y"])(
    "accepts %s for writing",
    (path) => {
      expect(() => {
        assertWritablePath(path);
      }).not.toThrow();
    },
  );

  it.each([
    ".github/workflows/ci.yml",
    ".github/CODEOWNERS",
    ".github/actions/setup/action.yml",
    ".GitHub/workflows/ci.yml",
    ".GITHUB/dependabot.yml",
    ".github",
    ".git/config",
    ".Git/hooks/pre-commit",
  ])("refuses to write %s", (path) => {
    expect(() => {
      assertWritablePath(path);
    }).toThrow(GuardError);
  });

  it.each([
    "",
    "/etc/passwd",
    "../outside",
    "src/../../x",
    "src/./x",
    "src//x",
    "src/",
    "C:/x",
    "src\\x",
    "src/\u0000x",
    "src/\nx",
    "a".repeat(4097),
  ])("refuses the path %j", (path) => {
    expect(() => {
      assertRepoPath(path);
    }).toThrow(GuardError);
  });
});

describe("parseFullName", () => {
  it("splits owner/name", () => {
    expect(parseFullName("octo-org/my.repo_1")).toEqual({ owner: "octo-org", repo: "my.repo_1" });
  });

  it.each([
    "octo",
    "octo/",
    "/repo",
    "octo/re/po",
    "octo/..",
    "octo/.",
    "-octo/repo",
    "octo/re po",
  ])("refuses %s", (value) => {
    expect(() => parseFullName(value)).toThrow(GuardError);
  });
});
