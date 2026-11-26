// tests.mode (SPEC §8.5): with `source_only`, any change to a test file (or test data, snapshots,
// fixtures: the test globs) is a violation, on either side of a rename. So is a change to a doctest
// in Python source (CHECKPOINT 3): `>>>` and `...` lines and the expected output after them.
import type { Change } from "../diff";
import { pathsOf, type Check, type Violation } from "./types";

/** 1-based numbers of the doctest lines in Python source: prompts and their expected output. */
export function doctestLines(content: string): Set<number> {
  const found = new Set<number>();
  let inExample = false;
  content.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (/^>>>(\s|$)/.test(trimmed)) inExample = true;
    else if (trimmed === "" || /^("""|''')/.test(trimmed)) inExample = false;
    if (inExample) found.add(index + 1);
  });
  return found;
}

/** Whether the change adds or removes a doctest line. */
function changesDoctest(change: Change): boolean {
  if (!/\.pyi?$/i.test(change.path)) return false;
  const before = doctestLines(change.oldContent ?? "");
  const after = doctestLines(change.newContent ?? "");
  for (const hunk of change.hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.type === "del" && before.has(oldLine)) return true;
      if (line.type === "add" && after.has(newLine)) return true;
      if (line.type !== "add") oldLine += 1;
      if (line.type !== "del") newLine += 1;
    }
  }
  return false;
}

export const checkTestEdits: Check = (changes, { policy, testFiles }) => {
  if (policy.tests.mode !== "source_only") return [];
  return changes.flatMap((change): Violation[] => {
    const path = pathsOf(change).find((candidate) => testFiles.matchAnywhere(candidate));
    if (path !== undefined) {
      return [
        {
          ruleId: "tests.mode",
          path,
          message: `${path} is a test file (or test data), and the policy only allows source changes.`,
          hint: "Fix the code under test so the existing tests pass, without changing them.",
        },
      ];
    }
    if (!changesDoctest(change)) return [];
    return [
      {
        ruleId: "tests.mode",
        path: change.path,
        message: `${change.path} changes a doctest (an example and its expected output), and the policy only allows source changes.`,
        hint: "Fix the code so its doctests pass as written.",
      },
    ];
  });
};
