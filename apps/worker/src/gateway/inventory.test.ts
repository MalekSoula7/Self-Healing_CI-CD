// Test inventories parsed by the server from the runner's JUnit reports (SPEC §8.6, P5.1a).
import { testInventoryRecordSchema } from "@pipeheal/db";
import { compareInventories } from "@pipeheal/policy";
import { describe, expect, it } from "vitest";
import { inventoryOf, inventoryRecord } from "./inventory";

const report = (cases: string) => ({
  path: "reports/junit.xml",
  xml: `<?xml version="1.0"?><testsuites><testsuite name="s">${cases}</testsuite></testsuites>`,
});

describe("inventoryRecord", () => {
  it("merges every report's tests into one stored inventory", () => {
    const record = inventoryRecord([
      report('<testcase classname="sum" name="adds"/>'),
      report('<testcase classname="sum" name="subtracts"><failure message="x"/></testcase>'),
    ]);

    expect(record).toEqual({
      available: true,
      tests: [
        ["sum::adds", ["passed"]],
        ["sum::subtracts", ["failed"]],
      ],
    });
    expect(testInventoryRecordSchema.safeParse(record).success).toBe(true);
  });

  it("says why there is no inventory: no report, or one it couldn't read whole", () => {
    expect(inventoryRecord([])).toEqual({ available: false, reason: "no JUnit report was found" });
    expect(
      inventoryRecord([report('<testcase name="a"/>'), { path: "r.xml", xml: "<!DOCTYPE x>" }]),
    ).toEqual({ available: false, reason: "a JUnit report couldn't be read" });
  });
});

describe("inventoryOf", () => {
  it("gives back an inventory the behavioral check can compare", () => {
    const baseline = inventoryOf(
      inventoryRecord([report('<testcase name="a"><failure/></testcase><testcase name="b"/>')]),
    );
    const after = inventoryOf(inventoryRecord([report('<testcase name="a"/>')]));
    if (baseline === null || after === null) throw new Error("test setup: no inventory");

    expect(compareInventories(baseline, after).map((violation) => violation.ruleId)).toEqual([
      "behavior.missingTests",
      "behavior.testCount",
    ]);
    expect(inventoryOf({ available: false, reason: "x" })).toBeNull();
  });
});
