// limits.maxFilesChanged and limits.maxLinesChanged (SPEC §8.5) on the whole change set.
import type { Check, Violation } from "./types";

export const checkSize: Check = (changes, { policy }) => {
  const { maxFilesChanged, maxLinesChanged } = policy.limits;
  const files = new Set(changes.map((change) => change.path)).size;
  const lines = changes.reduce((sum, change) => sum + change.addedLines + change.removedLines, 0);
  const violations: Violation[] = [];
  if (files > maxFilesChanged) {
    violations.push({
      ruleId: "limits.maxFilesChanged",
      message: `${String(files)} files changed; the policy allows ${String(maxFilesChanged)}.`,
      hint: "Make a smaller fix: change only the files the failure needs.",
    });
  }
  if (lines > maxLinesChanged) {
    violations.push({
      ruleId: "limits.maxLinesChanged",
      message: `${String(lines)} lines added or removed; the policy allows ${String(maxLinesChanged)}.`,
      hint: "Make a smaller fix: no reformatting or unrelated changes.",
    });
  }
  return violations;
};
