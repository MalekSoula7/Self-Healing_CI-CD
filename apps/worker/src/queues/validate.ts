// Validating a submission (SPEC §2 step 10, P5.1c), the `submissions` queue's job. The server
// fetches each submitted path at the target commit itself (a repository-scoped, read-only token),
// rebuilds the diff from those originals and the uploaded contents, and runs the full policy:
// static checks, the behavioral comparison with the step-1 baseline, the checks the runner
// reported, then (only when all of that passed, to spare the GPU) the AI judge on the team's
// judge rules. The attempt ends VALIDATED or REJECTED with what was found; it never stays
// VALIDATING silently (P5.1 review M1). Stored JSON is re-validated before use. A retry (P5.3d)
// is checked as the whole change: every attempt's files over the commit the first one healed,
// against that attempt's baseline, so two attempts can't do together what one may not.
import {
  forSystem,
  testInventoryRecordSchema,
  type Db,
  type SubmissionValidation,
  type SystemScope,
} from "@pipeheal/db";
import type { FileAtRef, GitHubApp } from "@pipeheal/github";
import { effectivePolicy } from "@pipeheal/policy";
import type { Logger } from "@pipeheal/shared/logger";
import {
  attemptCommandsSchema,
  submissionSchema,
  type Submission,
} from "@pipeheal/shared/protocol";
import { ZodError } from "zod";
import { judgeSubmission, type JudgeModel } from "../judge-model";
import { checkSubmission, submissionDigest, withJudge } from "../submission-check";
import type { ValidationJob } from "./submissions";

/** How long the judge may take over one submission (its calls share one GPU). */
export const JUDGE_BUDGET_MS = 10 * 60_000;
/** The checks heal-action runs after a fix, when configured (packages/heal-action FINAL_CHECKS). */
const FINAL_CHECKS = ["build", "lint", "typecheck", "test"] as const;

export interface ValidateDeps {
  db: Db;
  githubApp: GitHubApp | null;
  judge: JudgeModel;
  /** Queues the pull request of a submission that passed (P5.2). */
  enqueuePublish: (job: ValidationJob) => Promise<void>;
  now?: () => number;
}

type Found = NonNullable<Awaited<ReturnType<SystemScope["attempts"]["submissionFor"]>>>;

/** The stored submission, baseline and commands, re-validated; null when they don't parse. */
function readStored(found: Found) {
  try {
    return {
      files: submissionSchema.shape.files.parse(found.submission.files),
      checks: submissionSchema.shape.checks.parse(found.submission.checks),
      after: testInventoryRecordSchema.parse(found.submission.afterTests),
      baseline:
        found.baselineTests === null ? null : testInventoryRecordSchema.parse(found.baselineTests),
      commands: attemptCommandsSchema.parse(found.failure.repo.commands ?? {}),
    };
  } catch (error) {
    if (error instanceof ZodError) return null;
    throw error;
  }
}

type Stored = NonNullable<ReturnType<typeof readStored>>;

/** What is compared: the files over the healed commit, and the tests that ran on it. */
interface Compared {
  files: Submission["files"];
  originalSha: string;
  baseline: Stored["baseline"];
  /** What the earlier attempts left each path they touched as; empty for a first attempt. */
  earlier: ReadonlyMap<string, Submission["files"][number]>;
}

const UNREADABLE = "the earlier attempts' changes couldn't be read";

/**
 * For a retry, every attempt's files (a later one wins) since the first one's commit; or why they
 * can't be compared. A path an earlier attempt deleted can't be written again: the new file would
 * silently lose the original's mode (P5.3d review L2).
 */
async function compared(
  system: SystemScope,
  found: Found,
  stored: Stored,
): Promise<Compared | string> {
  if (found.retryOfId === null) {
    const { files, baseline } = stored;
    return { files, originalSha: found.targetSha, baseline, earlier: new Map() };
  }
  const chain = await system.attempts.chain(found.id);
  if (chain === null) return UNREADABLE;
  const earlier = new Map<string, Submission["files"][number]>();
  for (const uploaded of chain.earlierFiles) {
    const files = submissionSchema.shape.files.safeParse(uploaded);
    if (!files.success) return UNREADABLE;
    for (const file of files.data) earlier.set(file.path, file);
  }
  const merged = new Map(earlier);
  for (const file of stored.files) {
    const before = earlier.get(file.path);
    if (!("deleted" in file) && before !== undefined && "deleted" in before) {
      return `${file.path} was deleted by an earlier attempt and can't be re-created`;
    }
    merged.set(file.path, file);
  }
  const baseline =
    chain.baselineTests === null
      ? { success: true as const, data: null }
      : testInventoryRecordSchema.safeParse(chain.baselineTests);
  if (!baseline.success) return UNREADABLE;
  return {
    files: [...merged.values()],
    originalSha: chain.originalSha,
    baseline: baseline.data,
    earlier,
  };
}

/** Whether a file differs from what the retried commit already holds at its path. */
function changesParent(
  file: Submission["files"][number],
  earlier: Compared["earlier"],
  original: FileAtRef | null,
): boolean {
  const before = earlier.get(file.path);
  if (before !== undefined) {
    if ("deleted" in before) return !("deleted" in file);
    return "deleted" in file || file.content !== before.content;
  }
  if (original === null) return !("deleted" in file);
  return "deleted" in file || original.kind !== "text" || file.content !== original.content;
}

/** A refusal decided before any check ran: nothing was compared. */
export function refusal(reason: string): SubmissionValidation {
  return {
    passed: false,
    reasons: [reason.slice(0, 300)],
    violations: [],
    behavior: { available: false, reason: null },
    checks: [],
    judge: [],
    draftReasons: [],
    changedFiles: 0,
    digest: null,
  };
}

export async function validateSubmission(
  deps: ValidateDeps,
  job: ValidationJob,
  log: Logger,
): Promise<void> {
  const system = await forSystem(deps.db, job.orgId, "validator");
  const found = await system.attempts.submissionFor(job.attemptId);
  if (found?.status !== "VALIDATING") return;
  const reject = async (reason: string) => {
    await system.attempts.recordValidation(job.attemptId, refusal(reason));
    log.info({ attemptId: job.attemptId, reason }, "submission refused before checking");
  };
  const { repo } = found.failure;
  // Still ours to act on (review L2): no GitHub call or model call otherwise.
  if (found.org.status !== "ACTIVE" || !repo.enabled || repo.removedFromInstallationAt !== null) {
    await reject("the organization or repository is no longer enabled");
    return;
  }
  // Thrown, so the job retries and then records the failure (never completes silently).
  if (deps.githubApp === null) throw new Error("GitHub App isn't configured");

  const stored = readStored(found);
  // Stored data that doesn't parse won't parse on a retry either.
  if (stored === null) {
    await reject("the stored submission couldn't be read");
    return;
  }
  const { checks, after, commands } = stored;
  const whole = await compared(system, found, stored);
  if (typeof whole === "string") {
    await reject(whole);
    return;
  }
  const { originalSha, baseline, earlier } = whole;
  const { policy } = effectivePolicy(await system.policies.layers(repo.id));
  // Cheap refusals before fetching anything (review M5). Only a deletion of a path an earlier
  // attempt touched may turn out to be no change at all, so only those aren't counted yet.
  const counted = whole.files.filter((file) => !("deleted" in file && earlier.has(file.path)));
  if (counted.length > policy.limits.maxFilesChanged) {
    await reject(
      `the submission changes ${String(counted.length)} files; the policy allows ${String(policy.limits.maxFilesChanged)}`,
    );
    return;
  }

  // The originals, as GitHub has them at the healed commit: never what the runner says.
  const client = await deps.githubApp.readOnlyRepo(found.org.installationId, repo);
  const originals = new Map<string, FileAtRef | null>();
  for (const file of whole.files) {
    originals.set(file.path, await client.getFileAtRef(file.path, originalSha));
  }
  if (
    found.retryOfId !== null &&
    !stored.files.some((file) => changesParent(file, earlier, originals.get(file.path) ?? null))
  ) {
    await reject("the retry changes nothing");
    return;
  }
  // A file an earlier attempt added and this one removes is no change at all.
  const files =
    found.retryOfId === null
      ? whole.files
      : whole.files.filter((file) => !("deleted" in file && originals.get(file.path) === null));

  const checked = checkSubmission(
    {
      files,
      checks,
      originals,
      baseline,
      after,
      failingCheck: found.failingCheck,
      targetSha: found.targetSha,
      configuredChecks: FINAL_CHECKS.filter((name) => commands[name] !== undefined),
    },
    policy,
  );
  const { changes } = checked;
  // The digest is of this attempt's own files: what the pull request job commits.
  const validation: SubmissionValidation = {
    ...checked.validation,
    digest: submissionDigest(found.targetSha, stored.files),
  };
  let result = validation;
  if (validation.passed) {
    const now = deps.now ?? Date.now;
    const judged = await judgeSubmission(
      deps.judge,
      { policy, changes, deadline: now() + JUDGE_BUDGET_MS },
      log,
    );
    result = withJudge(validation, judged.report.outcomes, judged.decision.passed);
  }
  await system.attempts.recordValidation(job.attemptId, result);
  if (result.passed) await deps.enqueuePublish(job);
  // IDs and counts only: no file contents, no model text.
  log.info(
    {
      attemptId: job.attemptId,
      passed: result.passed,
      changedFiles: result.changedFiles,
      violations: result.violations.map((violation) => violation.ruleId),
      judged: result.judge.length,
      draft: result.draftReasons.length > 0,
    },
    "submission checked",
  );
}

/** After the job's last retry failed: the attempt is REJECTED rather than left VALIDATING. */
export async function recordUncheckable(db: Db, job: ValidationJob): Promise<void> {
  const system = await forSystem(db, job.orgId, "validator");
  const found = await system.attempts.submissionFor(job.attemptId);
  if (found?.status !== "VALIDATING") return;
  await system.attempts.recordValidation(
    job.attemptId,
    refusal("the submission couldn't be checked"),
  );
}
