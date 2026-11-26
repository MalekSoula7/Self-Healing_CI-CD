// limits.maxFilesChanged and limits.maxLinesChanged (SPEC §8.5) on the whole change set. A line
// counts as more than one when it packs more in (CHECKPOINT 3): over 200 characters it counts as
// one per 120, and with more than three `;` as one per statement, so 400 statements on one line
// aren't "1 line".
import type { Change } from "../diff";
import type { Check, Violation } from "./types";

const LONG_LINE = 200;
const CHARS_PER_LINE = 120;

export function lineWeight(text: string): number {
  const byLength = text.length > LONG_LINE ? Math.ceil(text.length / CHARS_PER_LINE) : 1;
  const statements = text.split(";").length - 1;
  return Math.max(byLength, statements > 3 ? statements : 1);
}

function weightedLines(change: Change): number {
  let total = 0;
  for (const hunk of change.hunks) {
    for (const line of hunk.lines) if (line.type !== "context") total += lineWeight(line.text);
  }
  return total;
}

export const checkSize: Check = (changes, { policy }) => {
  const { maxFilesChanged, maxLinesChanged } = policy.limits;
  const files = new Set(changes.map((change) => change.path)).size;
  const lines = changes.reduce((sum, change) => sum + weightedLines(change), 0);
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
      message: `${String(lines)} lines added or removed (long or packed lines count as several); the policy allows ${String(maxLinesChanged)}.`,
      hint: "Make a smaller fix: no reformatting, unrelated changes or packed lines.",
    });
  }
  return violations;
};
