// dependencies.mode and dependencies.allowNew (SPEC §8.5): every manifest compared old against
// new, entry by entry; lockfiles only alongside an allowed manifest change (or with mode `any`).
// A manifest that doesn't parse is refused whatever the mode: nothing in it can be checked.
import type { Change } from "../diff";
import { isLockfile, readManifest, type Dependency } from "../manifests";
import { changeLevel, levelAllowed, type ChangeLevel } from "../versions";
import type { Check, CheckContext, Violation } from "./types";

function dependenciesOf(path: string, content: string | null) {
  return content === null ? null : readManifest(path, content);
}

function describe(dependency: Dependency | undefined): string {
  return dependency === undefined
    ? "nothing"
    : dependency.spec === ""
      ? "any version"
      : dependency.spec;
}

function manifestViolations(change: Change, { policy }: CheckContext): Violation[] | null {
  const before = dependenciesOf(change.oldPath ?? change.path, change.oldContent);
  const after = dependenciesOf(change.path, change.newContent);
  if (before === null && after === null) return null;
  const path = change.path;
  for (const read of [before, after]) {
    if (read !== null && !read.ok) {
      return [
        {
          ruleId: "dependencies.mode",
          path,
          message: `${path} doesn't parse (${read.error.slice(0, 200)}), so its dependencies can't be checked.`,
          hint: "Keep the manifest valid.",
        },
      ];
    }
  }
  const old = before?.ok === true ? before.dependencies : new Map<string, Dependency>();
  const next = after?.ok === true ? after.dependencies : new Map<string, Dependency>();
  const { mode, allowNew } = policy.dependencies;
  const violations: Violation[] = [];
  for (const key of new Set([...old.keys(), ...next.keys()])) {
    const from = old.get(key);
    const to = next.get(key);
    if (from === undefined && to?.kind === "package") {
      if (!allowNew || mode === "frozen") {
        violations.push({
          ruleId: mode === "frozen" ? "dependencies.mode" : "dependencies.allowNew",
          path,
          message: `${path} adds ${key} (${describe(to)}), and the policy allows no new packages.`,
          hint: "Fix the failure with the dependencies the project already has.",
        });
      }
      continue;
    }
    const level: ChangeLevel =
      from === undefined || to === undefined ? "any" : changeLevel(from, to);
    if (!levelAllowed(mode, level)) {
      violations.push({
        ruleId: "dependencies.mode",
        path,
        message: `${path} changes ${key} from ${describe(from)} to ${describe(to)}, a${level === "any" ? " major or unclassifiable" : ` ${level}`} change; the policy allows ${mode === "frozen" ? "no dependency changes" : `${mode} changes`}.`,
        hint:
          mode === "frozen"
            ? "Leave dependencies as they are; fix the code instead."
            : `Keep dependency changes within ${mode} updates of what the project uses.`,
      });
    }
  }
  return violations;
}

export const checkDependencies: Check = (changes, context) => {
  const { mode } = context.policy.dependencies;
  const violations: Violation[] = [];
  let manifestChanged = false;
  for (const change of changes) {
    const found = manifestViolations(change, context);
    if (found === null) continue;
    manifestChanged ||= change.oldContent !== change.newContent;
    violations.push(...found);
  }
  const lockfileAllowed =
    mode === "any" || (mode !== "frozen" && manifestChanged && violations.length === 0);
  for (const change of changes) {
    if (lockfileAllowed || ![change.path, change.oldPath ?? change.path].some(isLockfile)) continue;
    violations.push({
      ruleId: "dependencies.mode",
      path: change.path,
      message: `${change.path} is a lockfile, and no allowed manifest change goes with it.`,
      hint: "Change a lockfile only together with the allowed manifest change it records.",
    });
  }
  return violations;
};
