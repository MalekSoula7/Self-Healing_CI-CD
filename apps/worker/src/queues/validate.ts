// Validating a submission (SPEC §2 step 10, P5.1c), the `submissions` queue's job. The server
// fetches each submitted path at the target commit itself (a repository-scoped, read-only token),
// rebuilds the diff from those originals and the uploaded contents, and runs the full policy:
// static checks, the behavioral comparison with the step-1 baseline, the checks the runner
// reported, then (only when all of that passed, to spare the GPU) the AI judge on the team's
// judge rules. The attempt ends VALIDATED or REJECTED with what was found; it never stays
// VALIDATING silently (P5.1 review M1). Stored JSON is re-validated before use.
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
import { attemptCommandsSchema, submissionSchema } from "@pipeheal/shared/protocol";
import { ZodError } from "zod";
import { judgeSubmission, type JudgeModel } from "../judge-model";
import { checkSubmission, withJudge } from "../submission-check";
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
  const { files, checks, after, baseline, commands } = stored;
  const { policy } = effectivePolicy(await system.policies.layers(repo.id));
  // Cheap refusals before fetching anything (review M5).
  if (files.length > policy.limits.maxFilesChanged) {
    await reject(
      `the submission changes ${String(files.length)} files; the policy allows ${String(policy.limits.maxFilesChanged)}`,
    );
    return;
  }

  // The originals, as GitHub has them at the target commit: never what the runner says.
  const client = await deps.githubApp.readOnlyRepo(found.org.installationId, repo);
  const originals = new Map<string, FileAtRef | null>();
  for (const file of files) {
    originals.set(file.path, await client.getFileAtRef(file.path, found.targetSha));
  }

  const { changes, validation } = checkSubmission(
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
