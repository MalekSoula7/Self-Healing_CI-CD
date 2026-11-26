// Why a fix's PR should open as a draft, from the changes alone (CHECKPOINT 3). Edits in a file
// that switches checks off file-wide (`@ts-nocheck`, a file-level `eslint-disable`, `# pylint:
// skip-file`, ...) are allowed, since refusing them would make legacy files unfixable, but the
// checks can't vouch for them: the PR opens as a draft and its body says why (Phase 4).
import type { Change } from "../diff";
import { addedLines } from "../source";

const FILE_WIDE = [
  /@ts-nocheck\b/,
  // eslint-disable for the rest of the file (not -line, -next-line).
  /\/\*\s*eslint-disable(?!-)\b/,
  /^\s*#\s*(pylint\s*:\s*skip-file|ruff\s*:\s*noqa\s*$|flake8\s*:\s*noqa\s*$|mypy\s*:\s*ignore-errors|type\s*:\s*ignore\s*$)/m,
  /\bistanbul\s+ignore\s+file\b|\bc8\s+ignore\s+file\b/,
];

/** One reason per changed file whose checks are switched off file-wide; empty when none. */
export function draftReasons(changes: readonly Change[]): string[] {
  return changes.flatMap((change) => {
    const content = change.newContent;
    if (content === null || addedLines(change).length === 0) return [];
    return FILE_WIDE.some((pattern) => pattern.test(content))
      ? [
          `${change.path} switches some checks off for the whole file, so they can't vouch for this edit.`,
        ]
      : [];
  });
}
