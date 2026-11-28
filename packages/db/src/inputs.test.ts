import { describe, expect, it } from "vitest";
import { githubLoginSchema, installedRepositorySchema, installedWorkflowSchema } from "./inputs";
import { hasRole } from "./scope";

describe("githubLoginSchema", () => {
  it.each(["octocat", "Octo-Cat", "a", "a1-b2-c3", "x".repeat(39)])("accepts %s", (login) => {
    expect(githubLoginSchema.safeParse(login).success).toBe(true);
  });

  it.each([
    "",
    "-octocat",
    "octocat-",
    "octo--cat",
    "octo_cat",
    "octo cat",
    "x".repeat(40),
    "../x",
  ])("rejects %j", (login) => {
    expect(githubLoginSchema.safeParse(login).success).toBe(false);
  });
});

describe("installedRepositorySchema", () => {
  const repo = { githubRepoId: 1n, fullName: "octo-org/my.repo_1", defaultBranch: "main" };

  it("accepts a GitHub repository", () => {
    expect(installedRepositorySchema.parse(repo)).toEqual(repo);
  });

  it.each([
    { ...repo, githubRepoId: 0n },
    { ...repo, fullName: "no-owner" },
    { ...repo, fullName: "owner/../etc" },
    { ...repo, fullName: "owner/.." },
    { ...repo, fullName: "owner/." },
    { ...repo, fullName: "owner/repo/extra" },
    { ...repo, defaultBranch: "" },
    { ...repo, extra: true },
  ])("rejects %o", (input) => {
    expect(installedRepositorySchema.safeParse(input).success).toBe(false);
  });
});

describe("installedWorkflowSchema", () => {
  const workflow = { githubWorkflowId: 1n, path: ".github/workflows/ci.yml", name: "CI" };

  it("accepts a workflow with known facts, and without them", () => {
    expect(
      installedWorkflowSchema.parse({ ...workflow, triggers: ["push"], usesEnvironment: false }),
    ).toEqual({ ...workflow, triggers: ["push"], usesEnvironment: false });
    expect(installedWorkflowSchema.parse(workflow)).toEqual(workflow);
  });

  it("accepts the CI-looking heuristic's suggested selection", () => {
    expect(installedWorkflowSchema.parse({ ...workflow, selected: true })).toEqual({
      ...workflow,
      selected: true,
    });
  });

  it.each([
    { ...workflow, githubWorkflowId: 0n },
    { ...workflow, path: "" },
    { ...workflow, name: "" },
    { ...workflow, triggers: Array.from({ length: 51 }, () => "push") },
    { ...workflow, usesEnvironment: "yes" },
    { ...workflow, selected: "yes" },
    { ...workflow, extra: true },
  ])("rejects %o", (input) => {
    expect(installedWorkflowSchema.safeParse(input).success).toBe(false);
  });
});

describe("hasRole", () => {
  it.each([
    ["OWNER", "ADMIN", true],
    ["OWNER", "OWNER", true],
    ["ADMIN", "ADMIN", true],
    ["ADMIN", "MEMBER", true],
    ["ADMIN", "OWNER", false],
    ["MEMBER", "ADMIN", false],
    ["MEMBER", "MEMBER", true],
  ] as const)("%s meets %s: %s", (role, minimum, expected) => {
    expect(hasRole(role, minimum)).toBe(expected);
  });
});
