// Behavioral checks (SPEC §8.6): the test inventory after a fix, against the baseline the runner
// recorded when it reproduced the failure. Static checks can be gamed; this is what actually ran.
// Not configurable. Both inventories are parsed on the server from the reports the runner sent.
import type { Violation } from "../checks/types";
import { testCount, type TestInventory, type TestOutcome } from "./junit";

const LISTED = 10;

function list(ids: readonly string[]): string {
  const shown = ids.slice(0, LISTED).join(", ");
  return ids.length > LISTED ? `${shown}, and ${String(ids.length - LISTED)} more` : shown;
}

function tests(count: number): string {
  return count === 1 ? "1 test" : `${String(count)} tests`;
}

function count(outcomes: readonly TestOutcome[], outcome: TestOutcome): number {
  return outcomes.filter((each) => each === outcome).length;
}

/**
 * Every rule the inventory after the fix breaks; empty when it holds. Test cases sharing an ID
 * are compared as a group: as many must run, no more may be skipped, and none may fail if any
 * failed before (still failing) or if none did (a regression).
 */
export function compareInventories(baseline: TestInventory, after: TestInventory): Violation[] {
  const missing: string[] = [];
  const newlySkipped: string[] = [];
  const stillFailing: string[] = [];
  const regressed: string[] = [];
  for (const [id, before] of baseline.tests) {
    const now = after.tests.get(id) ?? [];
    if (now.length < before.length) missing.push(id);
    if (count(now, "skipped") > count(before, "skipped")) newlySkipped.push(id);
    if (count(now, "failed") > 0) {
      (count(before, "failed") > 0 ? stillFailing : regressed).push(id);
    }
  }
  const baselineCount = testCount(baseline);
  const afterCount = testCount(after);

  const violations: Violation[] = [];
  if (missing.length > 0) {
    violations.push({
      ruleId: "behavior.missingTests",
      message: `${tests(missing.length)} from before the fix no longer ran: ${list(missing)}.`,
      hint: "Keep every test running under its name. Fix the code under test instead.",
    });
  }
  if (afterCount < baselineCount) {
    violations.push({
      ruleId: "behavior.testCount",
      message: `${tests(afterCount)} ran after the fix, down from ${tests(baselineCount)}.`,
      hint: "Keep every test running. Fix the code under test instead.",
    });
  }
  if (newlySkipped.length > 0) {
    violations.push({
      ruleId: "behavior.newlySkipped",
      message: `${tests(newlySkipped.length)} that ran before the fix are now skipped: ${list(newlySkipped)}.`,
      hint: "Run every test that ran before. Fix the code under test instead of skipping tests.",
    });
  }
  if (stillFailing.length > 0) {
    violations.push({
      ruleId: "behavior.stillFailing",
      message: `${tests(stillFailing.length)} still fail: ${list(stillFailing)}.`,
      hint: "The fix must make the failing tests pass.",
    });
  }
  if (regressed.length > 0) {
    violations.push({
      ruleId: "behavior.regressed",
      message: `${tests(regressed.length)} that passed before the fix now fail: ${list(regressed)}.`,
      hint: "Fix the failure without breaking tests that passed.",
    });
  }
  return violations;
}
