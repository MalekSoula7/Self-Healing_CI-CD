// suppressions.forbid (SPEC §8.5): comments that switch a check off, on added lines of any text
// file. Read on the raw line (suppressions live in comments), case-insensitively. A line that
// already carried one and is changed counts as added: the hint says to leave such lines alone.
import { addedLines } from "../source";
import type { Check } from "./types";

const SUPPRESSIONS: readonly RegExp[] = [
  /\beslint-(disable|enable)\b/i,
  /\/\*\s*eslint\s+[\w@/-]+\s*:/i,
  /@ts-(ignore|expect-error|nocheck)\b/i,
  /\b(tslint|jshint|stylelint)\s*[:-]\s*disable/i,
  /\b(biome|deno-lint|prettier)-ignore\b/i,
  /\b(istanbul|c8|v8)\s+ignore\b/i,
  /#.*\bnoqa\b/i,
  /#\s*type\s*:\s*ignore\b/i,
  /#\s*(pylint|flake8|mypy|pyright|ruff|pyre)\s*:\s*(disable|noqa|ignore)/i,
  /#\s*pyre-(ignore|fixme)\b/i,
  /#\s*pragma\s*:\s*no\s*(cover|branch)\b/i,
  /#\s*nosec\b/i,
];

export const checkSuppressions: Check = (changes, { policy }) => {
  if (!policy.suppressions.forbid) return [];
  return changes.flatMap((change) =>
    addedLines(change)
      .filter(({ text }) => SUPPRESSIONS.some((pattern) => pattern.test(text)))
      .map(({ line }) => ({
        ruleId: "suppressions.forbid",
        path: change.path,
        line,
        message: `${change.path}:${String(line)} adds a comment that suppresses a check.`,
        hint: "Fix what the check reports instead of silencing it. If the line already had this comment, leave the line unchanged.",
      })),
  );
};
