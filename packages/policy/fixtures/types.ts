// Fixtures for the static checks (SPEC §8.5, P3.4): for each family, changes the engine must
// allow and changes it must refuse. Each fixture runs through every check, so an allowed fixture
// also proves no other check fires on it. TypeScript data, not files on disk: the policy package
// does no I/O.
import type { ChangeInput, FileMode, FileState, PolicyLayer } from "../src/index";

export interface PolicyFixture {
  name: string;
  changes: ChangeInput[];
  /** Repo dashboard settings over the system defaults (an override: it may loosen). */
  policy?: PolicyLayer;
  /** Rule IDs the checks must report, as a multiset; empty when the change is allowed. */
  violations: string[];
}

export interface FixtureFamily {
  allowed: PolicyFixture[];
  forbidden: PolicyFixture[];
}

export const absent: FileState = { kind: "absent" };

export function text(content: string, mode: FileMode = "100644"): FileState {
  return { kind: "text", content, mode };
}

export function add(path: string, content: string): ChangeInput {
  return { path, old: absent, new: text(content) };
}

export function edit(path: string, before: string, after: string): ChangeInput {
  return { path, old: text(before), new: text(after) };
}

export function remove(path: string, content: string): ChangeInput {
  return { path, old: text(content), new: absent };
}

export function rename(oldPath: string, path: string, content: string): ChangeInput {
  return { path, oldPath, old: text(content), new: text(content) };
}

/** `count` lines `line 1` .. `line count`, each ending in a newline. */
export function lines(count: number, prefix = "line"): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${String(index + 1)}\n`).join("");
}
