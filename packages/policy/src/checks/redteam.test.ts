// P3.6: every red-team attack (packages/policy/fixtures/redteam) that names a real rule must be
// caught by it. Attacks that name only pseudo rules (`judge`, `server`, `new:*`, `decision:*`) are
// known residuals, listed in PROGRESS: no stated static rule can catch them.
import { describe, expect, it } from "vitest";
import { assertionAttacks } from "../../fixtures/redteam/assertions";
import { configAttacks } from "../../fixtures/redteam/configs";
import { dependencyAttacks } from "../../fixtures/redteam/dependencies";
import { falsePositives } from "../../fixtures/redteam/false-positives";
import { junitAttacks } from "../../fixtures/redteam/junit";
import { pathAttacks } from "../../fixtures/redteam/paths";
import { skipAttacks } from "../../fixtures/redteam/skips";
import { sourceAttacks } from "../../fixtures/redteam/source";
import { suppressionAttacks } from "../../fixtures/redteam/suppressions";
import type { Attack } from "../../fixtures/redteam/types";
import {
  buildChange,
  checkChanges,
  compareInventories,
  effectivePolicy,
  mergeInventories,
  parseJunit,
  type TestInventory,
} from "../index";

const PSEUDO = /^(judge|server|draft|new:|decision:)/;

const ATTACKS: [string, Attack][] = Object.entries({
  skips: skipAttacks,
  assertions: assertionAttacks,
  source: sourceAttacks,
  paths: pathAttacks,
  configs: configAttacks,
  suppressions: suppressionAttacks,
  dependencies: dependencyAttacks,
}).flatMap(([family, attacks]) => attacks.map((attack): [string, Attack] => [family, attack]));

const STATIC = ATTACKS.filter(([, attack]) =>
  attack.violations.some((id) => !PSEUDO.test(id) && !id.startsWith("behavior.")),
);

describe("red-team attacks on the static checks", () => {
  it.each(STATIC.map(([family, attack]) => [`${family}: ${attack.name}`, attack] as const))(
    "blocks %s",
    (_, attack) => {
      const { policy } = effectivePolicy(
        attack.policy === undefined ? {} : { repo: attack.policy },
      );
      const reported = checkChanges(attack.changes.map(buildChange), policy).map((v) => v.ruleId);
      const expected = attack.violations.filter((id) => !PSEUDO.test(id));

      expect(
        reported.some((id) => expected.includes(id)),
        `reported: ${reported.join(", ")}`,
      ).toBe(true);
    },
  );
});

describe("red-team false positives: ordinary fixes the checks must allow", () => {
  it.each(falsePositives.map((attack) => [attack.name, attack] as const))(
    "allows %s",
    (_, attack) => {
      const { policy } = effectivePolicy(
        attack.policy === undefined ? {} : { repo: attack.policy },
      );
      const reported = checkChanges(attack.changes.map(buildChange), policy).map((v) => v.ruleId);

      expect(reported).toEqual([]);
    },
  );
});

function inventory(reports: readonly string[]): TestInventory | null {
  const inventories: TestInventory[] = [];
  for (const xml of reports) {
    const read = parseJunit(xml);
    if (!read.ok) return null;
    inventories.push(read.inventory);
  }
  return mergeInventories(inventories);
}

const PARSE_ERRORS = junitAttacks.filter((attack) => attack.violations.includes("parse-error"));
const COMPARISONS = junitAttacks.filter((attack) => !attack.violations.includes("parse-error"));

describe("red-team attacks on the behavioral checks", () => {
  it.each(PARSE_ERRORS.map((attack) => [attack.name, attack] as const))(
    "refuses %s",
    (_, attack) => {
      expect(inventory(attack.baseline) === null || inventory(attack.after) === null).toBe(true);
    },
  );

  it.each(COMPARISONS.map((attack) => [attack.name, attack] as const))(
    "catches %s",
    (_, attack) => {
      const baseline = inventory(attack.baseline);
      const after = inventory(attack.after);
      const reported =
        baseline === null || after === null
          ? ["unreadable"]
          : compareInventories(baseline, after).map((v) => v.ruleId);
      const expected = attack.violations.filter((id) => !PSEUDO.test(id));

      // An attack that expects nothing at all is a false positive: the comparison must stay clean.
      const holds =
        attack.violations.length === 0
          ? reported.length === 0
          : expected.length === 0 || reported.some((id) => expected.includes(id));

      expect(holds, `reported: ${reported.join(", ")}`).toBe(true);
    },
  );
});
