// Every fixture family (packages/policy/fixtures) through every check: an allowed fixture passes
// all of them, a forbidden one breaks exactly the rules it names.
import { describe, expect, it } from "vitest";
import { configs } from "../../fixtures/configs";
import { dependencies } from "../../fixtures/dependencies";
import { heuristics } from "../../fixtures/heuristics";
import { invariants } from "../../fixtures/invariants";
import { paths } from "../../fixtures/paths";
import { size } from "../../fixtures/size";
import { suppressions } from "../../fixtures/suppressions";
import { assertions, skips, testEdits } from "../../fixtures/tests";
import type { FixtureFamily, PolicyFixture } from "../../fixtures/types";
import { buildChange, checkChanges, effectivePolicy, type Violation } from "../index";

const FAMILIES: Record<string, FixtureFamily> = {
  invariants,
  paths,
  size,
  testEdits,
  skips,
  assertions,
  suppressions,
  configs,
  dependencies,
  heuristics,
};

function check(fixture: PolicyFixture): Violation[] {
  const { policy } = effectivePolicy(fixture.policy === undefined ? {} : { repo: fixture.policy });
  return checkChanges(fixture.changes.map(buildChange), policy);
}

describe.each(Object.entries(FAMILIES))("%s fixtures", (_family, { allowed, forbidden }) => {
  it.each(allowed.map((fixture) => [fixture.name, fixture] as const))("allow %s", (_, fixture) => {
    expect(check(fixture)).toEqual([]);
  });

  it.each(forbidden.map((fixture) => [fixture.name, fixture] as const))(
    "refuse %s",
    (_, fixture) => {
      const violations = check(fixture);

      expect(violations.map((violation) => violation.ruleId).sort()).toEqual(
        [...fixture.violations].sort(),
      );
      for (const violation of violations) {
        expect(violation.message.length).toBeGreaterThan(0);
        expect(violation.hint.length).toBeGreaterThan(0);
      }
    },
  );

  it("has fixtures on both sides", () => {
    expect(allowed.length).toBeGreaterThan(0);
    expect(forbidden.length).toBeGreaterThan(0);
  });
});
