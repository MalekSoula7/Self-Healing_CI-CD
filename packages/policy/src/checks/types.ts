import type { Change } from "../diff";
import type { GlobList } from "../glob";
import type { EffectivePolicy } from "../merge";

/**
 * A broken rule (SPEC §8.5). `ruleId` is an invariant (`INV-*`) or the policy field it breaks
 * (`paths.deny`, `limits.maxFilesChanged`, ...). `path` is absent for rules on the whole change
 * set (size). `message` says what's wrong; `hint` says what to do instead, for the agent's next
 * iteration and the PR's evidence.
 */
export interface Violation {
  ruleId: string;
  path?: string;
  /** 1-based, in the new content (or the old one for a removed line). */
  line?: number;
  message: string;
  hint: string;
}

export interface CheckContext {
  policy: EffectivePolicy;
  /** The effective test globs, matched case-insensitively (a test file is protected anywhere). */
  testFiles: GlobList;
}

export type Check = (changes: readonly Change[], context: CheckContext) => Violation[];

/** Every path a change touches: a rename counts as both its old and its new path. */
export function pathsOf(change: Change): string[] {
  return change.oldPath === null ? [change.path] : [change.oldPath, change.path];
}
