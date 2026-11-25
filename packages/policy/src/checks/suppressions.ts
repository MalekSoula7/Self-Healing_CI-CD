// suppressions.forbid (SPEC §8.5): comments that switch a check off, on added lines of any text
// file. Read on the raw line (suppressions live in comments), case-insensitively. A line that
// already carried one and is changed counts as added: the hint says to leave such lines alone.
// A changed line right under an existing next-line directive counts too: the directive now
// silences new code.
import { addedLines } from "../source";
import type { Check, Violation } from "./types";

const SUPPRESSIONS: readonly RegExp[] = [
  /\b(eslint|oxlint)-(disable|enable)\b/i,
  /\/\*\s*eslint(-env)?\s+[\w@/-]+/i,
  /\/\*\s*globals?\s/i,
  /@ts-(ignore|expect-error|nocheck)\b/i,
  /\b(tslint|jshint|stylelint)\s*[:-]\s*disable/i,
  /\bjshint\s+ignore\b/i,
  /\b(biome|deno-lint|prettier)-ignore\b/i,
  /\b(istanbul|c8|v8)\s+ignore\b/i,
  /\bnode:coverage\s+(ignore|disable)\b/i,
  /#.*\bnoqa\b/i,
  /#\s*type\s*:\s*ignore\b/i,
  // Any per-file pyright or mypy setting (`# pyright: basic`, `# mypy: allow-untyped-defs`).
  /#\s*(pyright|mypy)\s*:/i,
  /#\s*(pylint|flake8|ruff|pyre)\s*:\s*(disable|noqa|ignore|skip-file)/i,
  /#\s*pyre-(ignore|fixme)\b/i,
  /#\s*(ruff\s*:\s*)?isort\s*:\s*(skip|off)/i,
  /#\s*fmt\s*:\s*(off|skip)\b/i,
  /#\s*pragma\s*:\s*no\s*(cover|branch)\b/i,
  /#\s*nosec\b/i,
];

/** Directives that apply to the line below them. */
const NEXT_LINE =
  /-next-line\b|@ts-(ignore|expect-error)\b|\b(biome|deno-lint|prettier)-ignore\b|\bignore\s+next\b/i;

export const checkSuppressions: Check = (changes, { policy }) => {
  if (!policy.suppressions.forbid) return [];
  return changes.flatMap((change) => {
    const lines = (change.newContent ?? "").split("\n");
    const added = addedLines(change);
    const addedNumbers = new Set(added.map(({ line }) => line));
    const violations: Violation[] = [];
    for (const { line, text } of added) {
      const above = lines[line - 2] ?? "";
      if (SUPPRESSIONS.some((pattern) => pattern.test(text))) {
        violations.push({
          ruleId: "suppressions.forbid",
          path: change.path,
          line,
          message: `${change.path}:${String(line)} adds a comment that suppresses a check.`,
          hint: "Fix what the check reports instead of silencing it. If the line already had this comment, leave the line unchanged.",
        });
      } else if (!addedNumbers.has(line - 1) && NEXT_LINE.test(above)) {
        violations.push({
          ruleId: "suppressions.forbid",
          path: change.path,
          line,
          message: `${change.path}:${String(line)} changes a line an existing suppression comment silences.`,
          hint: "Leave lines under suppression comments unchanged, or fix the code so the comment can go.",
        });
      }
    }
    return violations;
  });
};
