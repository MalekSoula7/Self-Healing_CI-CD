// paths.deny and paths.allow (SPEC §8.5) on every path a change touches. Deny globs also match the
// file a path is on case-insensitive checkouts (`Infra/` is `infra/` on Windows and macOS); allow
// globs match only as written, so they never let more through.
import { globList } from "../glob";
import { pathsOf, type Check, type Violation } from "./types";

export const checkPaths: Check = (changes, { policy }) => {
  const deny = globList(policy.paths.deny);
  const allowLists = policy.paths.allowAll.map((globs) => globList(globs));
  const violations: Violation[] = [];
  for (const change of changes) {
    for (const path of pathsOf(change)) {
      const denied = deny.matchAnywhere(path);
      if (denied !== undefined) {
        violations.push({
          ruleId: "paths.deny",
          path,
          message: `${path} matches the denied path ${denied}.`,
          hint: "The policy puts this path off limits. Fix the failure in other files, or report that it can't be fixed within the rules.",
        });
      }
      if (allowLists.some((list) => list.matchExact(path) === undefined)) {
        violations.push({
          ruleId: "paths.allow",
          path,
          message: `${path} is outside the paths the policy allows changing.`,
          hint: "Change only files inside the allowed paths, or report that the fix needs more.",
        });
      }
    }
  }
  return violations;
};
