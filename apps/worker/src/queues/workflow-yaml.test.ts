import { describe, expect, it } from "vitest";
import { isCiLooking, parseWorkflowYaml } from "./workflow-yaml";

function workflow(body: string): string {
  return `name: CI\n${body}`;
}

describe("parseWorkflowYaml", () => {
  it("reads a single string trigger", () => {
    expect(
      parseWorkflowYaml(workflow("on: push\njobs:\n  build:\n    runs-on: ubuntu-latest")),
    ).toEqual({ triggers: ["push"], usesEnvironment: false });
  });

  it("reads an array of triggers", () => {
    expect(
      parseWorkflowYaml(
        workflow("on: [push, pull_request]\njobs:\n  build:\n    runs-on: ubuntu-latest"),
      ),
    ).toEqual({ triggers: ["push", "pull_request"], usesEnvironment: false });
  });

  it("reads triggers from the object form, ignoring per-trigger config", () => {
    expect(
      parseWorkflowYaml(
        workflow(
          "on:\n  push:\n    branches: [main]\n  pull_request: {}\njobs:\n  build:\n    runs-on: ubuntu-latest",
        ),
      ),
    ).toEqual({ triggers: ["push", "pull_request"], usesEnvironment: false });
  });

  it("does not mistake the bare word `on` for a YAML 1.1 boolean (the Norway problem)", () => {
    const facts = parseWorkflowYaml(workflow("on: push\njobs: {}"));
    expect(facts?.triggers).toEqual(["push"]);
  });

  it("detects a job with a string environment", () => {
    expect(
      parseWorkflowYaml(
        workflow(
          "on: push\njobs:\n  deploy:\n    environment: production\n    runs-on: ubuntu-latest",
        ),
      ),
    ).toEqual({ triggers: ["push"], usesEnvironment: true });
  });

  it("detects a job with an object environment", () => {
    expect(
      parseWorkflowYaml(
        workflow(
          "on: push\njobs:\n  deploy:\n    environment:\n      name: production\n      url: https://x\n    runs-on: ubuntu-latest",
        ),
      ),
    ).toEqual({ triggers: ["push"], usesEnvironment: true });
  });

  it("is true if any job (not just the first) uses an environment", () => {
    expect(
      parseWorkflowYaml(
        workflow(
          "on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n  deploy:\n    environment: production\n    runs-on: ubuntu-latest",
        ),
      ),
    ).toEqual({ triggers: ["push"], usesEnvironment: true });
  });

  it("defaults to no triggers and no environment when on/jobs are absent", () => {
    expect(parseWorkflowYaml("name: Empty\n")).toEqual({ triggers: [], usesEnvironment: false });
  });

  it.each(["not: [valid, yaml", "\t- bad\n  - indent", "- just\n- a\n- list"])(
    "returns null for unparseable or non-object content: %j",
    (content) => {
      expect(parseWorkflowYaml(content)).toBeNull();
    },
  );

  it("ignores fields it doesn't use, so a workflow with extra keys still parses", () => {
    expect(
      parseWorkflowYaml(
        workflow(
          "on: workflow_dispatch\nconcurrency:\n  group: x\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps: []",
        ),
      ),
    ).toEqual({ triggers: ["workflow_dispatch"], usesEnvironment: false });
  });
});

describe("isCiLooking", () => {
  const ci = { triggers: ["push"], usesEnvironment: false, name: "CI", path: ".github/workflows/ci.yml" };

  it("is true for a plain push-triggered workflow with no environment", () => {
    expect(isCiLooking(ci)).toBe(true);
  });

  it("is true for pull_request as well as push", () => {
    expect(isCiLooking({ ...ci, triggers: ["pull_request"] })).toBe(true);
  });

  it("is false when neither push nor pull_request triggers it", () => {
    expect(isCiLooking({ ...ci, triggers: ["workflow_dispatch"] })).toBe(false);
  });

  it("is false when any job uses environment:", () => {
    expect(isCiLooking({ ...ci, usesEnvironment: true })).toBe(false);
  });

  it.each([
    { ...ci, name: "Deploy to production" },
    { ...ci, name: "Release" },
    { ...ci, name: "Publish package" },
    { ...ci, path: ".github/workflows/deploy.yml" },
  ])("is false when the name or path looks like a deploy/release/publish workflow: %o", (workflow) => {
    expect(isCiLooking(workflow)).toBe(false);
  });

});
