// tests.mode (SPEC §8.5): with `source_only`, any change to a test file (or test data, snapshots,
// fixtures: the test globs) is a violation, on either side of a rename.
import { pathsOf, type Check } from "./types";

export const checkTestEdits: Check = (changes, { policy, testFiles }) => {
  if (policy.tests.mode !== "source_only") return [];
  return changes.flatMap((change) => {
    const path = pathsOf(change).find((candidate) => testFiles.matchAnywhere(candidate));
    if (path === undefined) return [];
    return [
      {
        ruleId: "tests.mode",
        path,
        message: `${path} is a test file (or test data), and the policy only allows source changes.`,
        hint: "Fix the code under test so the existing tests pass, without changing them.",
      },
    ];
  });
};
