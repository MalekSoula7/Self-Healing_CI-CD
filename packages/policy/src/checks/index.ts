// The static checks (SPEC §8.5): every check, on changes the server built from full contents.
import type { Change } from "../diff";
import { globList } from "../glob";
import type { EffectivePolicy } from "../merge";
import { checkInvariants } from "./invariants";
import { checkPaths } from "./paths";
import { checkSize } from "./size";
import type { Check, Violation } from "./types";

export type { Violation } from "./types";

const CHECKS: readonly Check[] = [checkInvariants, checkPaths, checkSize];

/** Every rule the changes break under `policy`; empty when they pass. */
export function checkChanges(changes: readonly Change[], policy: EffectivePolicy): Violation[] {
  const context = { policy, testFiles: globList(policy.tests.testGlobs) };
  return CHECKS.flatMap((check) => check(changes, context));
}
