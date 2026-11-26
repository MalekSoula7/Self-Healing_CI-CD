// The static checks (SPEC §8.5): every check, on changes the server built from full contents.
import type { Change } from "../diff";
import { globList } from "../glob";
import type { EffectivePolicy } from "../merge";
import { checkAssertions } from "./assertions";
import { checkConfigs } from "./configs";
import { checkDependencies } from "./dependencies";
import { checkHeuristics } from "./heuristics";
import { checkInvariants } from "./invariants";
import { checkPaths } from "./paths";
import { checkSize } from "./size";
import { checkSkips } from "./skips";
import { checkSuppressions } from "./suppressions";
import { checkTestEdits } from "./test-edits";
import type { Check, Violation } from "./types";

export type { Violation } from "./types";
export { draftReasons } from "./draft";

const CHECKS: readonly Check[] = [
  checkInvariants,
  checkPaths,
  checkSize,
  checkTestEdits,
  checkSkips,
  checkAssertions,
  checkSuppressions,
  checkHeuristics,
  checkConfigs,
  checkDependencies,
];

/** Every rule the changes break under `policy`; empty when they pass. */
export function checkChanges(changes: readonly Change[], policy: EffectivePolicy): Violation[] {
  const context = { policy, testFiles: globList(policy.tests.testGlobs) };
  return CHECKS.flatMap((check) => check(changes, context));
}
