// The dispatcher's decision (P4.8): healable, in scope, set up.
import { effectivePolicy, type PolicyLayer } from "@pipeheal/policy";
import { describe, expect, it } from "vitest";
import { dispatchDecision, inScope, type DispatchFacts } from "./dispatch-decision";

const policy = (repo: PolicyLayer = {}) => effectivePolicy({ repo }).policy;

const facts = (overrides: Partial<DispatchFacts> = {}): DispatchFacts => ({
  category: "TEST",
  headBranch: "main",
  runs: [{ workflowPath: ".github/workflows/ci.yml", conclusion: "failure" }],
  commands: { install: ["npm", "ci"], test: ["npm", "test"], typecheck: ["npx", "tsc"] },
  workflows: [{ path: ".github/workflows/pipeheal.yml", triggers: ["workflow_dispatch"] }],
  ...overrides,
});

describe("dispatchDecision", () => {
  it("dispatches a healable failure in scope, with the check that shows it", () => {
    expect(dispatchDecision(facts(), policy())).toEqual({ kind: "dispatch", failingCheck: "test" });
    expect(dispatchDecision(facts({ category: "COMPILE" }), policy())).toEqual({
      kind: "dispatch",
      failingCheck: "typecheck",
    });
    expect(
      dispatchDecision(facts({ category: "COMPILE", commands: { build: ["make"] } }), policy()),
    ).toEqual({ kind: "dispatch", failingCheck: "build" });
    expect(
      dispatchDecision(
        facts({ category: "DEPENDENCY" }),
        policy({ scope: { categories: ["dependency"] } }),
      ),
    ).toEqual({ kind: "dispatch", failingCheck: "install" });
  });

  it.each([
    [{ category: "INFRA" }, "category infra is diagnosed only"],
    [{ category: null }, "category unknown is diagnosed only"],
    [{ category: "DEPENDENCY" }, "category dependency is diagnosed only"],
    [{ headBranch: null }, "the failed runs have no branch"],
    [{ headBranch: "pipeheal/abc-1" }, "PipeHeal doesn't heal its own branches"],
  ])("skips %o", (overrides, reason) => {
    expect(dispatchDecision(facts(overrides), policy())).toEqual({
      kind: "settle",
      status: "SKIPPED",
      reason,
    });
  });

  it("skips a branch or workflows outside the policy's scope", () => {
    expect(
      dispatchDecision(facts(), policy({ scope: { branches: { exclude: ["main"] } } })),
    ).toMatchObject({ status: "SKIPPED", reason: "the branch is out of the policy's scope" });
    expect(
      dispatchDecision(
        facts({
          runs: [
            { workflowPath: ".github/workflows/ci.yml", conclusion: "failure" },
            { workflowPath: ".github/workflows/e2e.yml", conclusion: "success" },
          ],
        }),
        policy({ scope: { workflows: { include: [".github/workflows/e2e.yml"] } } }),
      ),
    ).toMatchObject({
      status: "SKIPPED",
      reason: "a failing workflow is out of the policy's scope",
    });
    // One failing workflow out of scope is enough to stay at the diagnosis.
    expect(
      dispatchDecision(
        facts({
          runs: [
            { workflowPath: ".github/workflows/ci.yml", conclusion: "failure" },
            { workflowPath: ".github/workflows/deploy.yml", conclusion: "failure" },
          ],
        }),
        policy({ scope: { workflows: { exclude: [".github/workflows/deploy.yml"] } } }),
      ),
    ).toMatchObject({
      status: "SKIPPED",
      reason: "a failing workflow is out of the policy's scope",
    });
    expect(
      dispatchDecision(
        facts({ runs: [{ workflowPath: ".github/workflows/ci.yml", conclusion: "success" }] }),
        policy(),
      ),
    ).toMatchObject({ status: "SKIPPED", reason: "no workflow is still failing" });
  });

  it.each([
    [
      { workflows: [] },
      "the healer workflow .github/workflows/pipeheal.yml isn't on the default branch",
    ],
    [
      { workflows: [{ path: ".github/workflows/pipeheal.yml", triggers: ["push"] }] },
      "the healer workflow has no workflow_dispatch trigger",
    ],
    [{ commands: null }, "no test command is configured for the repository"],
    [{ commands: { test: "npm test" } }, "the repository's commands are invalid"],
  ])("needs setup for %o", (overrides, reason) => {
    expect(dispatchDecision(facts(overrides), policy())).toEqual({
      kind: "settle",
      status: "NEEDS_SETUP",
      reason,
    });
  });

  it("lets GitHub decide when the healer's triggers aren't known", () => {
    expect(
      dispatchDecision(
        facts({ workflows: [{ path: ".github/workflows/pipeheal.yml", triggers: [] }] }),
        policy(),
      ),
    ).toMatchObject({ kind: "dispatch" });
  });
});

describe("inScope", () => {
  it("needs a match in every include list and none in the excludes", () => {
    const globs = { includeAll: [["**"], ["release/**", "main"]], exclude: ["release/old"] };

    expect(inScope(globs, "main")).toBe(true);
    expect(inScope(globs, "release/2.0")).toBe(true);
    expect(inScope(globs, "release/old")).toBe(false);
    expect(inScope(globs, "feature/x")).toBe(false);
  });

  it("treats a glob that doesn't compile as narrowing", () => {
    const broken = `{${"a,".repeat(5_000)}}`;

    expect(inScope({ includeAll: [[broken]], exclude: [] }, "a")).toBe(false);
    expect(inScope({ includeAll: [["**"]], exclude: [broken] }, "a")).toBe(false);
  });
});
