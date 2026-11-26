// dependencies.mode and dependencies.allowNew (SPEC §8.5): every manifest compared old against
// new, entry by entry; lockfiles only alongside an allowed manifest change (or with mode `any`).
// A manifest that doesn't parse is refused whatever the mode: nothing in it can be checked.
import type { Change } from "../diff";
import {
  isDependencySettingsFile,
  isForeignSource,
  lockfileEcosystem,
  manifestEcosystem,
  readManifest,
  type Dependency,
  type Ecosystem,
} from "../manifests";
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

interface ManifestResult {
  violations: Violation[];
  /** A dependency entry really changed (not just bytes elsewhere in the file). */
  changed: boolean;
}

function manifestViolations(change: Change, { policy }: CheckContext): ManifestResult | null {
  const before = dependenciesOf(change.oldPath ?? change.path, change.oldContent);
  const after = dependenciesOf(change.path, change.newContent);
  if (before === null && after === null) return null;
  const path = change.path;
  for (const read of [before, after]) {
    if (read !== null && !read.ok) {
      return {
        changed: true,
        violations: [
          {
            ruleId: "dependencies.mode",
            path,
            message: `${path} doesn't parse (${read.error.slice(0, 200)}), so its dependencies can't be checked.`,
            hint: "Keep the manifest valid.",
          },
        ],
      };
    }
  }
  const old = before?.ok === true ? before.dependencies : new Map<string, Dependency>();
  const next = after?.ok === true ? after.dependencies : new Map<string, Dependency>();
  const { mode, allowNew } = policy.dependencies;
  const violations: Violation[] = [];
  let changed = false;
  for (const key of new Set([...old.keys(), ...next.keys()])) {
    const from = old.get(key);
    const to = next.get(key);
    const level: ChangeLevel =
      from === undefined || to === undefined ? "any" : changeLevel(from, to);
    if (level === "none") continue;
    changed = true;
    // Installing from another source (a git URL, an npm: alias) is a new package too.
    const newPackage =
      to?.kind === "package" &&
      (from === undefined || (isForeignSource(to) && to.spec !== from.spec));
    if (newPackage && (!allowNew || mode === "frozen")) {
      violations.push({
        ruleId: mode === "frozen" ? "dependencies.mode" : "dependencies.allowNew",
        path,
        message: `${path} adds ${key} (${describe(to)}), and the policy allows no new packages.`,
        hint: "Fix the failure with the dependencies the project already has.",
      });
      if (from === undefined) continue;
    }
    // An allowed new package.
    if (from === undefined && to?.kind === "package") continue;
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
  return { violations, changed };
}

export const checkDependencies: Check = (changes, context) => {
  const { mode } = context.policy.dependencies;
  const violations: Violation[] = [];
  const changedEcosystems = new Set<Ecosystem>();
  for (const change of changes) {
    const found = manifestViolations(change, context);
    if (found === null) continue;
    if (found.changed) changedEcosystems.add(manifestEcosystem(change.path));
    violations.push(...found.violations);
  }
  const manifestsAllowed = violations.length === 0;
  for (const change of changes) {
    const paths = [change.oldPath ?? change.path, change.path];
    // A .patch/.diff that is test data (under the test globs) isn't a patch to a dependency.
    const settings = paths.some(
      (path) =>
        isDependencySettingsFile(path) &&
        !(/\.(patch|diff)$/i.test(path) && context.testFiles.matchAnywhere(path) !== undefined),
    );
    if (mode !== "any" && settings) {
      violations.push({
        ruleId: "dependencies.mode",
        path: change.path,
        message: `${change.path} decides which dependency versions or sources get installed; the policy allows ${mode === "frozen" ? "no dependency changes" : `only ${mode} changes`}.`,
        hint: "Leave registry, workspace, toolchain and patch settings as they are.",
      });
      continue;
    }
    const ecosystem = paths.map(lockfileEcosystem).find((found) => found !== null);
    if (ecosystem === undefined || mode === "any") continue;
    // A lockfile only alongside an allowed change to a dependency of its own ecosystem.
    if (mode !== "frozen" && manifestsAllowed && changedEcosystems.has(ecosystem)) continue;
    violations.push({
      ruleId: "dependencies.mode",
      path: change.path,
      message: `${change.path} is a lockfile, and no allowed ${ecosystem} dependency change goes with it.`,
      hint: "Change a lockfile only together with the allowed manifest change it records.",
    });
  }
  return violations;
};
