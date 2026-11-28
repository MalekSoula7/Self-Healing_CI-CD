// SPEC §8.2's invariants a change can break: INV-GITHUB-DIR, INV-PATH, INV-SECRETS,
// INV-FILE-TYPES, INV-TEST-DELETE. Not configurable: no policy is consulted except the test globs
// (which can only grow, so they can only protect more files).
import { writablePathProblem } from "@pipeheal/shared/repo-path";
import type { Change } from "../diff";
import { globList } from "../glob";
import { INVARIANT_PATHS } from "../invariants";
import { pathsOf, type Check, type CheckContext, type Violation } from "./types";

const githubDir = globList(INVARIANT_PATHS["INV-GITHUB-DIR"]);
const secrets = globList(INVARIANT_PATHS["INV-SECRETS"]);

function pathViolations(path: string): Violation[] {
  const violations: Violation[] = [];
  if (githubDir.matchAnywhere(path) !== undefined) {
    violations.push({
      ruleId: "INV-GITHUB-DIR",
      path,
      message: `${path} is under .github/, which PipeHeal never changes.`,
      hint: "Fix the failure in the code it tests, without touching workflows or repository settings.",
    });
  } else {
    const problem = writablePathProblem(path);
    if (problem !== null) {
      violations.push({
        ruleId: "INV-PATH",
        path,
        message: `${path}: ${problem}.`,
        hint: "Change only ordinary files, with names every operating system reads the same way.",
      });
    }
  }
  if (secrets.matchAnywhere(path) !== undefined) {
    violations.push({
      ruleId: "INV-SECRETS",
      path,
      message: `${path} looks like a secret (an .env file, key, certificate or secrets directory).`,
      hint: "Leave secrets and environment files alone; the fix must not depend on them.",
    });
  }
  return violations;
}

function fileTypeViolations(change: Change): Violation[] {
  const kinds = new Set([change.oldKind, change.newKind]);
  const reasons = [
    kinds.has("binary") ? "a binary file" : null,
    kinds.has("symlink") ? "a symlink" : null,
    kinds.has("submodule") ? "a submodule" : null,
    change.modeChanged ? "a file mode change" : null,
  ].filter((reason) => reason !== null);
  return reasons.map((reason) => ({
    ruleId: "INV-FILE-TYPES",
    path: change.path,
    message: `${change.path} is ${reason}, which PipeHeal never changes.`,
    hint: "Change only the text content of regular files, keeping their modes.",
  }));
}

/**
 * Deleting a test file, or renaming one at all: a rename that stays inside a directory glob
 * (`tests/test_a.py` -> `tests/a_checks.py`) or gets a new extension (`a.test.ts.off`) can still
 * take it out of what the runner collects, and a fix never needs to rename a test.
 */
function testDeleteViolations(change: Change, { testFiles }: CheckContext): Violation[] {
  const isTest = (path: string) => testFiles.matchAnywhere(path) !== undefined;
  const deleted = change.status === "deleted" && isTest(change.path);
  const renamed = change.oldPath !== null && isTest(change.oldPath);
  if (!deleted && !renamed) return [];
  const path = change.oldPath ?? change.path;
  return [
    {
      ruleId: "INV-TEST-DELETE",
      path,
      message: deleted
        ? `${path} is a test file, and it was deleted.`
        : `${path} is a test file, and it was renamed to ${change.path}.`,
      hint: "Keep every test file where it is. Make the code pass its tests instead.",
    },
  ];
}

export const checkInvariants: Check = (changes, context) =>
  changes.flatMap((change) => [
    ...pathsOf(change).flatMap(pathViolations),
    ...fileTypeViolations(change),
    ...testDeleteViolations(change, context),
  ]);
