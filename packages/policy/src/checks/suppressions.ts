// suppressions.forbid (SPEC §8.5): comments that switch a check off, on added lines of any text
// file, read on the raw line (suppressions live in comments), case-insensitively. A line that
// already carried one and is changed counts as added: the hint says to leave such lines alone.
// Also (P3.6):
// - a changed line right under an existing next-line directive (the directive now silences it);
// - a changed line inside a block an existing directive covers (`istanbul ignore next` above a
//   function, `# pragma: no cover` on its `def`);
// - a deleted directive that switches checks back on (`eslint-enable`, `// @ts-check`), which
//   stretches an earlier suppression or drops type checking.
import type { Change } from "../diff";
import { addedLines, at } from "../source";
import type { Check, Violation } from "./types";

const SUPPRESSIONS: readonly RegExp[] = [
  /\b(eslint|oxlint)-disable\b/i,
  /\/\*\s*eslint(-env)?\s+[\w@/-]+/i,
  // `/* global x */` declares globals for ESLint; case-sensitive, so prose ("Global ...") is fine.
  /\/\*\s*globals?\s/,
  /@ts-(ignore|expect-error|nocheck)\b/i,
  /\b(tslint|jshint|stylelint)\s*[:-]\s*disable/i,
  /\bjshint\s+ignore\b/i,
  /\b(biome|deno-lint|prettier|dprint)-ignore\b/i,
  /\b(istanbul|c8|v8)\s+ignore\b/i,
  /\bnode:coverage\s+(ignore|disable)\b/i,
  /\bNOSONAR\b/,
  /\bcspell\s*:\s*(disable|ignore)/i,
  /\bshellcheck\s+disable\b/i,
  /\bmarkdownlint-(disable|capture)\b/i,
  /\byamllint\s+disable\b/i,
  /\bsvelte-ignore\b/i,
  /#.*\bnoqa\b/i,
  /#\s*type\s*:\s*ignore\b/i,
  // Any per-file pyright, mypy or pytype setting (`# pyright: basic`, `# mypy: allow-untyped-defs`).
  /#\s*(pyright|mypy|pytype)\s*:/i,
  /#\s*(pylint|flake8|ruff|pyre)\s*:\s*(disable|noqa|ignore|skip-file)/i,
  /#\s*pyre-(ignore|fixme|unsafe)\b/i,
  /#\s*(ruff\s*:\s*)?isort\s*:\s*(skip|off)/i,
  /#\s*(fmt|yapf)\s*:\s*(off|skip|disable)\b/i,
  // coverage.py accepts `pragma: no cover` and `pragma no cover`.
  /#\s*pragma\s*:?\s*no\s*(cover|branch)\b/i,
  /#\s*nosec\b/i,
];

/** Directives that apply to the line below them. */
const NEXT_LINE =
  /-next-line\b|@ts-(ignore|expect-error)\b|\b(biome|deno-lint|dprint)-ignore\b|\bignore\s+next\b/i;
/** Directives that cover the block they head (the next statement, or the `def` they sit on). */
const BLOCK =
  /\b(istanbul|c8|v8)\s+ignore\s+(next|if|else)\b|#\s*pragma\s*:?\s*no\s*(cover|branch)\b/i;
/** Directives whose removal switches checks off for more code. */
const ENABLING =
  /\b(eslint|oxlint)-enable\b|@ts-check\b|#\s*pyre-strict\b|#\s*mypy\s*:\s*strict\b/i;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Whether a block-level directive covers line `index` (0-based): on an enclosing line, or just above one. */
function underBlockDirective(
  lines: readonly string[],
  index: number,
  added: ReadonlySet<number>,
): boolean {
  let threshold = indentOf(at(lines, index));
  for (let previous = index - 1; previous >= 0 && threshold > 0; previous -= 1) {
    const ancestor = at(lines, previous);
    if (ancestor.trim() === "" || indentOf(ancestor) >= threshold) continue;
    threshold = indentOf(ancestor);
    // Only a directive the file already had: one added with the code is reported on its own.
    const onLine = BLOCK.test(ancestor) && !added.has(previous + 1);
    const above = BLOCK.test(at(lines, previous - 1)) && !added.has(previous);
    if (onLine || above) return true;
  }
  return false;
}

function violation(change: Change, line: number, message: string, hint: string): Violation {
  return {
    ruleId: "suppressions.forbid",
    path: change.path,
    line,
    message: `${change.path}:${String(line)} ${message}`,
    hint,
  };
}

function removedEnabling(change: Change): Violation[] {
  const violations: Violation[] = [];
  for (const hunk of change.hunks) {
    let oldLine = hunk.oldStart;
    for (const line of hunk.lines) {
      if (line.type === "del" && ENABLING.test(line.text)) {
        violations.push(
          violation(
            change,
            oldLine,
            "removes a comment that switches checks back on (the suppression before it now reaches further).",
            "Keep eslint-enable, @ts-check and similar comments where they are.",
          ),
        );
      }
      if (line.type !== "add") oldLine += 1;
    }
  }
  return violations;
}

export const checkSuppressions: Check = (changes, { policy }) => {
  if (!policy.suppressions.forbid) return [];
  return changes.flatMap((change) => {
    const lines = (change.newContent ?? "").split("\n");
    const added = addedLines(change);
    const addedNumbers = new Set(added.map(({ line }) => line));
    const violations = removedEnabling(change);
    for (const { line, text } of added) {
      const above = at(lines, line - 2);
      if (SUPPRESSIONS.some((pattern) => pattern.test(text))) {
        violations.push(
          violation(
            change,
            line,
            "adds a comment that suppresses a check.",
            "Fix what the check reports instead of silencing it. If the line already had this comment, leave the line unchanged.",
          ),
        );
      } else if (
        (!addedNumbers.has(line - 1) && NEXT_LINE.test(above)) ||
        underBlockDirective(lines, line - 1, addedNumbers)
      ) {
        violations.push(
          violation(
            change,
            line,
            "changes code an existing suppression comment covers.",
            "Leave code under suppression comments unchanged, or fix it so the comment can go.",
          ),
        );
      }
    }
    return violations;
  });
};
