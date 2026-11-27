// Checking a submission on the server (SPEC §2 step 10, §8.5-8.6, P5.1c). Pure: the job fetches
// the originals and runs the judge. The runner's diff is never used: each change is rebuilt from
// the file at the target commit (as GitHub has it) and the final content the runner uploaded,
// then the full static policy runs on those changes, the tests after the fix are compared with
// the baseline, and the checks the runner reports must have passed.
import { createHash } from "node:crypto";
import type { JudgeOutcome } from "@pipeheal/agent-core";
import type { SubmissionValidation, TestInventoryRecord } from "@pipeheal/db";
import type { FileAtRef } from "@pipeheal/github";
import {
  buildChange,
  checkChanges,
  compareInventories,
  draftReasons,
  type Change,
  type EffectivePolicy,
  type FileState,
  type Violation,
} from "@pipeheal/policy";
import type { Submission } from "@pipeheal/shared/protocol";
import { inventoryOf } from "./gateway/inventory";

export interface SubmissionFacts {
  files: Submission["files"];
  checks: readonly { name: string; exitCode: number | null }[];
  /** Each submitted path at the target commit; null when it doesn't exist there. */
  originals: ReadonlyMap<string, FileAtRef | null>;
  /** The attempt's baseline tests; null when none was recorded. */
  baseline: TestInventoryRecord | null;
  after: TestInventoryRecord;
  /** The check that reproduced the failure: it must pass now. */
  failingCheck: string;
  /** The commit the files are compared with (and the PR's parent). */
  targetSha: string;
  /** Every check configured for the repository: each must have run and passed (review M2). */
  configuredChecks: readonly string[];
}

const LIMITS = { reasons: 20, violations: 100, draftReasons: 20 } as const;

/** A file at the target commit as packages/policy reads it, or why it can't be compared. */
function oldState(original: FileAtRef | null): FileState | string {
  if (original === null) return { kind: "absent" };
  switch (original.kind) {
    case "text":
      return { kind: "text", content: original.content, mode: "100644" };
    case "binary":
      return { kind: "binary", mode: "100644" };
    case "symlink":
      return { kind: "symlink" };
    case "submodule":
      return { kind: "submodule" };
    case "too_large":
      return "is too large to compare with the target commit";
    case "not_a_file":
      return "is a directory at the target commit";
  }
}

/**
 * Paths a single commit can't hold (P5.1 review L1): the same path twice once case is ignored
 * (case-insensitive checkouts collide), or a file under a path that is itself submitted as a
 * file. Refused here, before the attempt is VALIDATED, rather than by the commit in P5.2.
 */
function commitProblems(files: readonly { path: string }[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const { path } of files) {
    const folded = path.toLowerCase();
    const earlier = seen.get(folded);
    if (earlier !== undefined) problems.push(`${path} and ${earlier} differ only in case`);
    seen.set(folded, path);
  }
  const paths = new Set(files.map((file) => file.path));
  for (const { path } of files) {
    const parts = path.split("/");
    for (let end = 1; end < parts.length; end++) {
      const parent = parts.slice(0, end).join("/");
      if (paths.has(parent)) problems.push(`${path} is inside ${parent}, also submitted as a file`);
    }
  }
  return problems;
}

/**
 * What was checked, as one SHA-256 (P5.1 review L1): the target commit, then each path in order
 * with its final content's own SHA-256 (or that it is deleted). The pull request (P5.2) recomputes
 * it from the stored submission and commits nothing that differs.
 */
export function submissionDigest(targetSha: string, files: Submission["files"]): string {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) =>
      "deleted" in file
        ? `${JSON.stringify(file.path)} deleted`
        : `${JSON.stringify(file.path)} ${createHash("sha256").update(file.content, "utf8").digest("hex")}`,
    );
  return createHash("sha256")
    .update([targetSha, ...lines].join("\n"), "utf8")
    .digest("hex");
}

function violationRecord(violation: Violation) {
  return {
    ruleId: violation.ruleId.slice(0, 100),
    message: violation.message.slice(0, 1_000),
    path: violation.path?.slice(0, 4_096) ?? null,
  };
}

/** The static and behavioral checks, and the runner's checks. The judge is added after. */
export function checkSubmission(
  facts: SubmissionFacts,
  policy: EffectivePolicy,
): { changes: Change[]; validation: SubmissionValidation } {
  const reasons: string[] = commitProblems(facts.files);
  const changes: Change[] = [];
  for (const file of facts.files) {
    const original = facts.originals.get(file.path);
    if (original === undefined) {
      reasons.push(`${file.path} wasn't read at the target commit`);
      continue;
    }
    const old = oldState(original);
    if (typeof old === "string") {
      reasons.push(`${file.path} ${old}`);
      continue;
    }
    if ("deleted" in file && old.kind === "absent") {
      reasons.push(`${file.path} is deleted but doesn't exist at the target commit`);
      continue;
    }
    const mode = old.kind === "text" || old.kind === "binary" ? old.mode : "100644";
    // Classified as GitHub would read it (a NUL makes git treat it as binary): the protocol
    // refuses such content already, this keeps INV-FILE-TYPES in charge here too (review H1).
    const next: FileState =
      "deleted" in file
        ? { kind: "absent" }
        : file.content.includes("\0")
          ? { kind: "binary", mode }
          : { kind: "text", content: file.content, mode };
    const unchanged = old.kind === "text" && next.kind === "text" && old.content === next.content;
    if (!unchanged) changes.push(buildChange({ path: file.path, old, new: next }));
  }
  if (changes.length === 0 && reasons.length === 0) reasons.push("the submission changes nothing");

  // Behavioral checks (SPEC §8.6). Without a baseline they are unavailable: tests may not change
  // at all (`tests.mode` forced to source_only) and the PR opens as a draft.
  const violations: Violation[] = [];
  const drafts = draftReasons(changes);
  // A baseline without tests proves nothing: treated like none at all (review M3).
  const recorded = facts.baseline === null ? null : inventoryOf(facts.baseline);
  const baseline = recorded !== null && recorded.tests.size > 0 ? recorded : null;
  let behavior: SubmissionValidation["behavior"];
  let checkedPolicy = policy;
  if (baseline === null) {
    const why =
      facts.baseline === null
        ? "no baseline was recorded"
        : facts.baseline.available
          ? "the baseline report had no tests"
          : facts.baseline.reason;
    behavior = { available: false, reason: why.slice(0, 300) };
    drafts.push(`Behavioral checks were unavailable (${why}), so test files were left alone.`);
    checkedPolicy = { ...policy, tests: { ...policy.tests, mode: "source_only" } };
  } else {
    behavior = { available: true, reason: null };
    const after = inventoryOf(facts.after);
    if (after === null) {
      reasons.push("the tests couldn't be read after the fix");
    } else {
      violations.push(...compareInventories(baseline, after));
    }
  }
  violations.push(...checkChanges(changes, checkedPolicy));

  // The runner's checks: every configured one, and the one that reproduced the failure, must have
  // run, and every one reported must have passed. A check left out doesn't count as passed.
  for (const name of new Set([facts.failingCheck, ...facts.configuredChecks])) {
    if (!facts.checks.some((check) => check.name === name)) {
      reasons.push(`the ${name} check wasn't run after the fix`);
    }
  }
  for (const check of facts.checks) {
    if (check.exitCode === 0) continue;
    reasons.push(
      check.exitCode === null
        ? `the ${check.name} check didn't finish after the fix`
        : `the ${check.name} check failed after the fix`,
    );
  }

  return {
    changes,
    validation: {
      passed: reasons.length === 0 && violations.length === 0,
      reasons: reasons.slice(0, LIMITS.reasons).map((reason) => reason.slice(0, 300)),
      violations: violations.slice(0, LIMITS.violations).map(violationRecord),
      behavior,
      checks: facts.checks.map((check) => ({ name: check.name, exitCode: check.exitCode })),
      judge: [],
      draftReasons: drafts.slice(0, LIMITS.draftReasons).map((draft) => draft.slice(0, 500)),
      changedFiles: changes.length,
      digest: submissionDigest(facts.targetSha, facts.files),
    },
  };
}

/** Adds the AI judge's verdicts (P4.7): any violated or unjudged rule refuses the submission. */
export function withJudge(
  validation: SubmissionValidation,
  outcomes: readonly JudgeOutcome[],
  passed: boolean,
): SubmissionValidation {
  const judge = outcomes.map((outcome) => ({
    ruleId: outcome.ruleId,
    layer: outcome.layer,
    outcome:
      outcome.kind === "unjudged"
        ? ("unjudged" as const)
        : outcome.violated
          ? ("violated" as const)
          : ("passed" as const),
    detail: (outcome.kind === "unjudged" ? outcome.reason : outcome.reasoning).slice(0, 600),
  }));
  const reasons = passed
    ? validation.reasons
    : [...validation.reasons, "the AI judge found a team rule broken, or couldn't check one"];
  return {
    ...validation,
    judge,
    passed: validation.passed && passed,
    reasons: reasons.slice(0, LIMITS.reasons),
  };
}
