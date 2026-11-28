// What CI says about PipeHeal's commit (SPEC §9.1, P5.3a): green only when nothing watched failed
// and every workflow that failed originally ran on it and succeeded.
import { describe, expect, it } from "vitest";
import { ciVerdict, jobsProven, type CiRun } from "./ci-verdict";

const run = (workflowId: bigint, conclusion: string | null, status = "completed"): CiRun => ({
  id: workflowId * 100n,
  workflowId,
  status,
  conclusion,
  event: "pull_request",
});
const required = new Set([1n]);

describe("ciVerdict", () => {
  const running = { kind: "pending", waitingFor: "finish" };
  const unproven = { kind: "pending", waitingFor: "proof" };

  it("waits while no run has started", () => {
    expect(ciVerdict([], required)).toEqual({ kind: "pending", waitingFor: "start" });
  });

  it("waits while any run is still going, even if another already failed", () => {
    const runs = [run(1n, "failure"), run(2n, null, "in_progress")];

    expect(ciVerdict(runs, required)).toEqual(running);
  });

  it("is green when the originally failing workflow succeeded and nothing failed", () => {
    const runs = [run(1n, "success"), run(2n, "skipped"), run(3n, "neutral")];

    expect(ciVerdict(runs, required)).toEqual({ kind: "green" });
  });

  it.each(["failure", "timed_out", "startup_failure"])(
    "is red when any watched run ends in %s",
    (conclusion) => {
      const failing = run(2n, conclusion);

      expect(ciVerdict([run(1n, "success"), failing], required)).toEqual({
        kind: "red",
        failed: [failing],
      });
    },
  );

  it("isn't green when a workflow that failed originally didn't run", () => {
    expect(ciVerdict([run(2n, "success")], required)).toEqual(unproven);
  });

  it.each(["skipped", "cancelled", "neutral", "action_required", "stale", null])(
    "isn't green when the originally failing workflow ended %s",
    (conclusion) => {
      expect(ciVerdict([run(1n, conclusion)], required)).toEqual(unproven);
    },
  );

  it("needs every originally failing workflow to succeed", () => {
    const both = new Set([1n, 2n]);

    expect(ciVerdict([run(1n, "success")], both)).toEqual(unproven);
    expect(ciVerdict([run(1n, "success"), run(2n, "success")], both)).toEqual({ kind: "green" });
  });

  it("accepts a cancelled duplicate when another run of the workflow succeeded", () => {
    expect(ciVerdict([run(1n, "cancelled"), run(1n, "success")], required)).toEqual({
      kind: "green",
    });
  });

  it.each(["workflow_dispatch", "schedule", "merge_group"])(
    "takes no proof from a %s run, though its failure counts",
    (event) => {
      expect(ciVerdict([{ ...run(1n, "success"), event }], required)).toEqual(unproven);
      const failing = { ...run(1n, "failure"), event };
      expect(ciVerdict([run(1n, "success"), failing], required)).toEqual({
        kind: "red",
        failed: [failing],
      });
    },
  );

  it("is never green with nothing required (fails closed)", () => {
    expect(ciVerdict([run(1n, "success")], new Set())).toEqual(unproven);
  });
});

describe("jobsProven", () => {
  const failedJob = { workflowId: 1n, name: "check", failedStep: "Test" };
  const ran = (overrides: Partial<Parameters<typeof jobsProven>[1][number]> = {}) => ({
    workflowId: 1n,
    name: "check",
    conclusion: "success",
    succeededSteps: ["Set up job", "Test"],
    ...overrides,
  });

  it("holds when the failed job ran again and its failed step passed", () => {
    expect(jobsProven([failedJob], [ran()])).toBe(true);
    const noStep = { ...failedJob, failedStep: null };
    expect(jobsProven([noStep], [ran({ succeededSteps: [] })])).toBe(true);
  });

  it.each([
    ["was skipped", { conclusion: "skipped" }],
    ["didn't run (another job did)", { name: "lint" }],
    ["ran in another workflow", { workflowId: 2n }],
    ["skipped the step that failed", { succeededSteps: ["Set up job"] }],
  ])("fails when the failed job %s", (_case, overrides) => {
    expect(jobsProven([failedJob], [ran(overrides)])).toBe(false);
  });

  it("needs every originally failed job", () => {
    const two = [failedJob, { workflowId: 1n, name: "lint", failedStep: null }];

    expect(jobsProven(two, [ran()])).toBe(false);
    expect(jobsProven(two, [ran(), ran({ name: "lint" })])).toBe(true);
  });
});
