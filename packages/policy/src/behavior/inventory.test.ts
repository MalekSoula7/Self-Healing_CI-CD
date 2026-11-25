// SPEC §8.6: the inventory after a fix against the baseline recorded when the failure was
// reproduced. Written before the implementation.
import { describe, expect, it } from "vitest";
import {
  JEST_BASELINE,
  JEST_FIXED,
  PYTEST_BASELINE,
  PYTEST_FIXED,
  VITEST_BASELINE,
  VITEST_FIXED,
} from "../../fixtures/junit";
import { compareInventories } from "./inventory";
import { parseJunit, type TestInventory, type TestOutcome } from "./junit";

function parsed(xml: string): TestInventory {
  const read = parseJunit(xml);
  if (!read.ok) throw new Error(read.error);
  return read.inventory;
}

function inventory(tests: Record<string, TestOutcome>): TestInventory {
  return { tests: new Map(Object.entries(tests)) };
}

const BASELINE = inventory({ a: "passed", b: "failed", c: "skipped", d: "passed" });

function ruleIds(after: Record<string, TestOutcome>): string[] {
  return compareInventories(BASELINE, inventory(after)).map((violation) => violation.ruleId);
}

describe("compareInventories", () => {
  it.each([
    ["Jest", JEST_BASELINE, JEST_FIXED],
    ["Vitest", VITEST_BASELINE, VITEST_FIXED],
    ["pytest", PYTEST_BASELINE, PYTEST_FIXED],
  ])("passes a good %s fix", (_, baseline, fixed) => {
    expect(compareInventories(parsed(baseline), parsed(fixed))).toEqual([]);
  });

  it("refuses the reproduced failure itself", () => {
    expect(
      compareInventories(parsed(PYTEST_BASELINE), parsed(PYTEST_BASELINE)).map((v) => v.ruleId),
    ).toEqual(["behavior.stillFailing"]);
  });

  it("allows new tests and a skipped test that now runs", () => {
    expect(ruleIds({ a: "passed", b: "passed", c: "passed", d: "passed", e: "passed" })).toEqual(
      [],
    );
  });

  it("refuses a missing test (and the lower count)", () => {
    expect(ruleIds({ a: "passed", b: "passed", c: "skipped" })).toEqual([
      "behavior.missingTests",
      "behavior.testCount",
    ]);
  });

  it("refuses a missing test even when another one replaces it", () => {
    expect(ruleIds({ a: "passed", b: "passed", c: "skipped", e: "passed" })).toEqual([
      "behavior.missingTests",
    ]);
  });

  it("refuses a test newly skipped", () => {
    expect(ruleIds({ a: "skipped", b: "passed", c: "skipped", d: "passed" })).toEqual([
      "behavior.newlySkipped",
    ]);
  });

  it("refuses a failing test skipped instead of fixed, once", () => {
    expect(ruleIds({ a: "passed", b: "skipped", c: "skipped", d: "passed" })).toEqual([
      "behavior.newlySkipped",
    ]);
  });

  it("refuses a regression", () => {
    expect(ruleIds({ a: "passed", b: "passed", c: "skipped", d: "failed" })).toEqual([
      "behavior.regressed",
    ]);
  });

  it("names a few tests and counts the rest", () => {
    const many = inventory(
      Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`t${String(i)}`, "passed"])),
    );
    const [violation] = compareInventories(many, inventory({}));

    expect(violation?.message).toContain("30 tests");
    expect(violation?.message).toContain("t0");
    expect(violation?.message).toContain("and 20 more");
    expect(violation?.message).not.toContain("t29");
  });
});
