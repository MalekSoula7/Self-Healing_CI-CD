import { describe, expect, it } from "vitest";
import {
  GuardError,
  assertBranchName,
  assertCommitMessage,
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

describe("writable paths on Windows and macOS checkouts", () => {
  it.each([
    "GITHUB~1/workflows/ci.yml",
    "github~2/x",
    ".github./workflows/ci.yml",
    ".github /workflows/ci.yml",
    "vendor/lib/.git/hooks/post-checkout",
    "vendor/lib/.GIT/config",
    "vendor/GIT~1/config",
    ".gitmodules",
    "sub/.GitModules",
    ".git‌/config",
    "src/a‍.ts",
    "src/aux.ts",
    "src/CON",
    "src/com1.txt",
    "src/lpt¹",
    "src/file.",
    "src/file ",
    "src/a:b.ts",
    "src/what?.ts",
  ])("refuses %j", (path) => {
    expect(() => {
      assertWritablePath(path);
    }).toThrow(GuardError);
  });

  it.each([
    "src/auxiliary.ts",
    "src/console.ts",
    "docs/git-guide.md",
    ".gitignore",
    ".gitattributes",
  ])("accepts %s", (path) => {
    expect(() => {
      assertWritablePath(path);
    }).not.toThrow();
  });
});

describe("branch names", () => {
  it.each(["main", "release/2.0", "feature/x_y-z.1"])("accepts %s", (branch) => {
    expect(() => {
      assertBranchName(branch);
    }).not.toThrow();
  });

  it.each([
    "",
    "-main",
    "/main",
    "main/",
    "a..b",
    "a//b",
    "x.lock",
    "a b",
    "main\n",
    "a~1",
    "a^b",
    "a:b",
  ])("refuses %j", (branch) => {
    expect(() => {
      assertBranchName(branch);
    }).toThrow(GuardError);
  });
});

describe("commit messages", () => {
  it("accepts a normal message", () => {
    expect(() => {
      assertCommitMessage("fix: handle empty config [PipeHeal]\n\nRoot cause: ...");
    }).not.toThrow();
  });

  it.each([
    "fix: x [skip ci]",
    "fix: x [CI SKIP]",
    "fix: x [no ci]",
    "fix: x [skip actions]",
    "fix: x [actions skip]",
    "fix: x\n\nskip-checks: true",
    "fix: x\n\nSkip-Checks:true",
    "",
    "   ",
  ])("refuses %j", (message) => {
    expect(() => {
      assertCommitMessage(message);
    }).toThrow(GuardError);
  });
});
