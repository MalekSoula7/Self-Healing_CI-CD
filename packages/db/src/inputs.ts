// zod schemas for everything the data helpers accept from callers (CLAUDE.md: validate every
// external input). Callers pass values that came from users, webhooks or the GitHub API.
import { attemptCommandsSchema } from "@pipeheal/shared/protocol";
import { z } from "zod";

export const idSchema = z.uuid();

/** GitHub numeric IDs are positive. */
export const githubIdSchema = z.bigint().positive();

/** GitHub account logins: alphanumerics and single hyphens, at most 39 characters. */
export const githubLoginSchema = z.string().regex(/^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/);

export const installationInputSchema = z.strictObject({
  githubAccountId: githubIdSchema,
  login: githubLoginSchema,
  accountType: z.enum(["ORG", "USER"]),
  installationId: githubIdSchema,
  /** The `installation` webhook's sender (OWNER candidate, SPEC §5.2). */
  installerGithubId: githubIdSchema.optional(),
});
export type InstallationInput = z.infer<typeof installationInputSchema>;

export const installedRepositorySchema = z.strictObject({
  githubRepoId: githubIdSchema,
  // owner/name; "." and ".." are not repository names (they would be path segments in API URLs).
  fullName: z.string().regex(/^[A-Za-z0-9-]+\/(?!\.\.?$)[A-Za-z0-9._-]+$/),
  defaultBranch: z.string().min(1).max(255),
});
export type InstalledRepository = z.infer<typeof installedRepositorySchema>;

export const installedWorkflowSchema = z.strictObject({
  githubWorkflowId: githubIdSchema,
  // Repo-relative POSIX path, e.g. ".github/workflows/ci.yml".
  path: z.string().min(1).max(500),
  name: z.string().min(1).max(255),
  // Both undefined when the workflow file couldn't be fetched or parsed (SPEC §11, §6.2 step 8):
  // callers keep any previously known facts rather than overwriting them with empty defaults.
  triggers: z.array(z.string().min(1).max(100)).max(50).optional(),
  usesEnvironment: z.boolean().optional(),
  // The "CI-looking" heuristic's suggestion (SPEC §11), applied only the moment a workflow is
  // first discovered (see syncInstalled): once a workflow exists, only the admin's own choice on
  // /[org]/repos/[repo] can change `selected`, so this is ignored on every later sync.
  selected: z.boolean().optional(),
});
export type InstalledWorkflow = z.infer<typeof installedWorkflowSchema>;

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const githubUrlSchema = z.url({ protocol: /^https$/ }).max(2000);

/** A failed job of a run's latest attempt, as GitHub lists it (SPEC §10 FailedJob). */
export const failedJobInputSchema = z.strictObject({
  githubJobId: githubIdSchema,
  name: z.string().min(1).max(500),
  failedStep: z.string().min(1).max(500).nullable(),
  htmlUrl: githubUrlSchema.nullable(),
});
export type FailedJobInput = z.infer<typeof failedJobInputSchema>;

/** A completed workflow run that failed, from a `workflow_run` webhook (SPEC §2.1). */
export const failedRunInputSchema = z.strictObject({
  headSha: shaSchema,
  headBranch: z.string().min(1).max(255).nullable(),
  runId: githubIdSchema,
  runAttempt: z.int().positive(),
  workflowId: githubIdSchema,
  workflowName: z.string().min(1).max(255),
  workflowPath: z.string().min(1).max(500),
  conclusion: z.enum(["failure", "timed_out"]),
  htmlUrl: githubUrlSchema.nullable(),
  // GitHub caps a workflow run at 256 jobs.
  jobs: z.array(failedJobInputSchema).max(256),
});
export type FailedRunInput = z.infer<typeof failedRunInputSchema>;

/**
 * What triage learned about one failed job (SPEC §6.2). `errorWindow` must already be redacted.
 * `redactions` (counts per kind, no content) only goes to the audit log.
 */
const signalLocationSchema = z.strictObject({
  path: z.string().min(1).max(500),
  line: z.int().nonnegative(),
  column: z.int().nonnegative().optional(),
});

/** Signals parsed from a failed job's redacted log (agent-core's `Signals`, SPEC §6.2 step 5). */
export const jobSignalsSchema = z.strictObject({
  failedStep: z.string().max(255).nullable(),
  exitCode: z.int().nullable(),
  tools: z.array(z.string().min(1).max(20)).max(20),
  diagnostics: z
    .array(
      z.strictObject({
        tool: z.string().min(1).max(20),
        severity: z.enum(["error", "warning"]),
        message: z.string().max(600),
        code: z.string().max(100).optional(),
        path: z.string().min(1).max(500).optional(),
        line: z.int().nonnegative().optional(),
        column: z.int().nonnegative().optional(),
      }),
    )
    .max(50),
  failingTests: z.array(z.string().min(1).max(1_000)).max(50),
  locations: z.array(signalLocationSchema).max(50),
  errorCodes: z.array(z.string().min(1).max(100)).max(50),
});
export type JobSignals = z.infer<typeof jobSignalsSchema>;

/** SPEC §6.1's triage categories, as triage names them. */
export const triageCategorySchema = z.enum([
  "compile",
  "typecheck",
  "lint",
  "test",
  "dependency",
  "build",
  "infra",
  "config",
  "flaky",
  "unknown",
]);
export type TriageCategory = z.infer<typeof triageCategorySchema>;

/** A classification: for one failed job, or the failure as a whole. */
export const classificationSchema = z.strictObject({
  category: triageCategorySchema,
  confidence: z.number().min(0).max(1),
  /** Built from redacted text only. */
  summary: z.string().min(1).max(1_000),
});
export type ClassificationInput = z.infer<typeof classificationSchema>;

/** One model call and its cost (SPEC §7.5, §13). */
export const modelCallInputSchema = z.strictObject({
  purpose: z.string().regex(/^[a-z][a-z-]{0,39}$/),
  model: z.string().min(1).max(100),
  promptVersion: z.string().min(1).max(50),
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cacheReadTokens: z.int().nonnegative(),
  cacheWriteTokens: z.int().nonnegative(),
  costUsd: z.number().nonnegative().max(1_000),
  outcome: z.enum(["valid", "invalid", "error"]),
});
export type ModelCallInput = z.infer<typeof modelCallInputSchema>;

export const jobTriageInputSchema = z.strictObject({
  errorWindow: z.string().max(200_000),
  signals: jobSignalsSchema.optional(),
  classification: classificationSchema.optional(),
  redactions: z.record(z.string().regex(/^[a-z-]{1,40}$/), z.int().nonnegative()).optional(),
});
export type JobTriageInput = z.infer<typeof jobTriageInputSchema>;

const redactionCountsSchema = z.record(z.string().regex(/^[a-z-]{1,40}$/), z.int().nonnegative());

/**
 * What changed since the last green commit (SPEC §6.2 step 7), as agent-core's
 * `selectRecentChanges` produced it: redacted, within its token budget.
 */
export const recentChangesSchema = z.strictObject({
  totalCommits: z.int().nonnegative(),
  commits: z
    .array(
      z.strictObject({
        sha: shaSchema,
        subject: z.string().max(200),
        authorLogin: z.string().max(39).nullable(),
      }),
    )
    .max(250),
  omittedCommits: z.int().nonnegative(),
  totalFiles: z.int().nonnegative(),
  files: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(4_096),
        previousPath: z.string().min(1).max(4_096).nullable(),
        status: z.string().min(1).max(20),
        additions: z.int().nonnegative(),
        deletions: z.int().nonnegative(),
        priority: z.boolean(),
        patch: z.string().max(400_000).nullable(),
        patchState: z.enum(["full", "partial", "omitted", "none"]),
      }),
    )
    .max(300),
  omittedFiles: z.int().nonnegative(),
  githubTruncated: z.boolean(),
  estimatedTokens: z.int().nonnegative(),
  tokenBudget: z.int().positive().max(100_000),
  redactions: redactionCountsSchema,
});
export type RecentChangesInput = z.infer<typeof recentChangesSchema>;

/**
 * The commit a failure is compared with, and how it was found: the workflow's last green run on
 * the same branch, else on the default branch, else the default branch's tip (the comparison
 * then starts at the merge base).
 */
export const changesBaseSchema = z.strictObject({
  sha: shaSchema,
  source: z.enum(["same-branch", "default-branch", "merge-base"]),
  branch: z.string().min(1).max(255),
  /** The green run that made this commit the base (a digit string: JSON has no BigInt). */
  runId: z
    .string()
    .regex(/^[1-9]\d{0,19}$/)
    .nullable(),
});

/** What's stored for a failure: no base when nothing to compare with was found. */
export const recentChangesRecordSchema = z.union([
  z.strictObject({ base: changesBaseSchema, changes: recentChangesSchema }),
  z.strictObject({ base: z.null(), reason: z.string().min(1).max(200) }),
]);
export type RecentChangesRecord = z.infer<typeof recentChangesRecordSchema>;

export const MAX_POLICY_FILE_ERRORS = 20;

/**
 * `.pipeheal.yml` as read at a commit (P3.7): a layer (validated by packages/policy before it gets
 * here; a plain JSON object to this package), or the errors that kept it out; neither when there
 * is no file.
 */
export const policyFileRecordSchema = z
  .strictObject({
    commitSha: shaSchema,
    layer: z.record(z.string(), z.unknown()).nullable(),
    errors: z.array(z.string().min(1).max(300)).min(1).max(MAX_POLICY_FILE_ERRORS).nullable(),
  })
  .refine((record) => record.layer === null || record.errors === null, {
    message: "a policy file has a layer or errors, not both",
  });
export type PolicyFileRecord = z.infer<typeof policyFileRecordSchema>;

/** A later attempt of a run that passed (SPEC §2.1 re-runs). */
export const passedRunInputSchema = z.strictObject({
  runId: githubIdSchema,
  runAttempt: z.int().positive(),
});
export type PassedRunInput = z.infer<typeof passedRunInputSchema>;

/**
 * X-GitHub-Delivery header value. GitHub-shaped (UUID-looking), but the column is a plain
 * String (not Postgres `uuid`), so this stays a loose length check rather than `z.uuid()`.
 */
export const deliveryIdSchema = z.string().min(1).max(100);

export const webhookDeliverySchema = z.strictObject({
  /** X-GitHub-Delivery header. Redeliveries reuse it. */
  deliveryId: deliveryIdSchema,
  event: z.string().min(1).max(100),
  action: z.string().max(100).optional(),
  installationId: githubIdSchema.optional(),
});
export type WebhookDeliveryInput = z.infer<typeof webhookDeliverySchema>;

/** SPEC §10's failure statuses. */
export const failureStatusSchema = z.enum([
  "DETECTED",
  "TRIAGED",
  "SKIPPED",
  "FLAKY",
  "QUEUED",
  "HEALING",
  "PR_OPENED",
  "VERIFIED",
  "UNVERIFIED",
  "NEEDS_HUMAN",
  "NEEDS_SETUP",
  "NOT_REPRODUCIBLE",
  "FAILED",
]);

/** A page of an organization's failures, newest first (SPEC §11 failures list). */
export const failurePageSchema = z.strictObject({
  take: z.int().min(1).max(100).default(25),
  /** Failures older than this one (IDs are UUIDv7, so time-ordered). */
  before: idSchema.optional(),
  repoId: idSchema.optional(),
  status: failureStatusSchema.optional(),
});
export type FailurePage = z.input<typeof failurePageSchema>;

export const auditPageSchema = z.strictObject({
  take: z.int().min(1).max(200).default(50),
  /**
   * Return entries older than this audit entry ID. IDs are UUIDv7: time-ordered, and Prisma
   * generates them monotonically within a process (checked in P1.2), so ID order is write order.
   */
  before: idSchema.optional(),
});
export type AuditPage = z.input<typeof auditPageSchema>;

/** The checks a failure can be reproduced with (SPEC §7.2; `test_file` is a tool, not a target). */
export const reproducibleCheckSchema = z.enum(["install", "build", "lint", "typecheck", "test"]);

/** A dispatched healing attempt (SPEC §2 step 7), as the dispatcher records it. */
export const attemptInputSchema = z.strictObject({
  failureId: z.uuid(),
  targetSha: shaSchema,
  failingCheck: reproducibleCheckSchema,
  /** The healer run GitHub created, when the dispatch API returned it. */
  dispatchRunId: githubIdSchema.optional(),
});
export type AttemptInput = z.input<typeof attemptInputSchema>;

/**
 * The dispatcher's claim on a triaged failure (P4.8, D18): the check to reproduce and the caps
 * checked in the same transaction that creates the attempt.
 */
export const dispatchClaimSchema = z.strictObject({
  failureId: z.uuid(),
  failingCheck: reproducibleCheckSchema,
  /** The effective policy's `limits.maxAttemptsPerFailure`. */
  maxAttemptsPerFailure: z.int().min(1).max(10),
  /** Attempts the organization may start in any 24 hours. */
  maxAttemptsPerDay: z.int().min(1).max(10_000),
});
export type DispatchClaimInput = z.input<typeof dispatchClaimSchema>;

/** Why the dispatcher left a triaged failure alone for good: diagnosis only, or setup needed. */
export const failureSettleSchema = z.strictObject({
  status: z.enum(["SKIPPED", "NEEDS_SETUP"]),
  reason: z.string().trim().min(1).max(300),
});
export type FailureSettleInput = z.input<typeof failureSettleSchema>;

/**
 * A test inventory as stored (SPEC §8.6): packages/policy's `TestInventory` as `[id, outcomes]`
 * pairs, parsed by the server from JUnit reports, or why there is none (no report configured,
 * one that couldn't be read). Bounded like the parser: 50,000 tests, IDs of 1,000 characters
 * (hashed beyond that, with a short suffix for repeats).
 */
export const testInventoryRecordSchema = z.discriminatedUnion("available", [
  z.strictObject({
    available: z.literal(true),
    tests: z
      .array(
        z.tuple([
          z.string().min(1).max(1_100),
          z
            .array(z.enum(["passed", "failed", "skipped"]))
            .min(1)
            .max(50_000),
        ]),
      )
      .max(50_000),
  }),
  z.strictObject({ available: z.literal(false), reason: z.string().trim().min(1).max(300) }),
]);
export type TestInventoryRecord = z.infer<typeof testInventoryRecordSchema>;

/**
 * What checking a submission found (P5.1c), as stored on the attempt and shown in the PR body and
 * the timeline: why it was refused, the policy's violations on the server-built diff, whether the
 * behavioral checks could run, the checks the runner reported, the AI judge's verdicts, and why
 * the PR would open as a draft. Text is bounded here; the judge's reasoning is already one line.
 */
export const submissionValidationSchema = z.strictObject({
  passed: z.boolean(),
  reasons: z.array(z.string().trim().min(1).max(300)).max(20),
  violations: z
    .array(
      z.strictObject({
        ruleId: z.string().min(1).max(100),
        message: z.string().min(1).max(1_000),
        path: z.string().max(4_096).nullable(),
      }),
    )
    .max(100),
  behavior: z.strictObject({
    available: z.boolean(),
    reason: z.string().max(300).nullable(),
  }),
  checks: z
    .array(z.strictObject({ name: z.string().min(1).max(20), exitCode: z.int().nullable() }))
    .max(10),
  judge: z
    .array(
      z.strictObject({
        ruleId: z.string().min(1).max(20),
        layer: z.string().min(1).max(200),
        outcome: z.enum(["passed", "violated", "unjudged"]),
        detail: z.string().max(600),
      }),
    )
    .max(60),
  draftReasons: z.array(z.string().min(1).max(500)).max(20),
  changedFiles: z.int().nonnegative(),
  /**
   * SHA-256 of what was checked (the target commit, each path and its final content): the pull
   * request (P5.2) commits only a submission with this digest. Null when nothing was compared.
   */
  digest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});
export type SubmissionValidation = z.infer<typeof submissionValidationSchema>;

/**
 * The model's account of its fix, from `submit_fix` (P5.2): untrusted model text, bounded here and
 * escaped wherever it is shown (the PR body, the dashboard).
 */
// Empty fields are kept as empty: a submit isn't refused for what the model left out.
export const fixSummarySchema = z.strictObject({
  rootCause: z.string().max(1_200),
  changes: z.string().max(1_200),
  verification: z.string().max(1_200),
  confidence: z.enum(["low", "medium", "high"]),
});
export type FixSummary = z.infer<typeof fixSummarySchema>;

/** A `pipeheal/*` branch name, as packages/github's guard accepts it. */
export const healBranchSchema = z
  .string()
  .regex(/^pipeheal\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/)
  .refine((name) => !name.includes("..") && !name.endsWith(".lock"), "not a valid branch name");

/** The pull request PipeHeal opened for an attempt (P5.2c). */
export const pullRequestRecordSchema = z.strictObject({
  number: z.int().positive(),
  url: z.url({ protocol: /^https$/ }).max(500),
  draft: z.boolean(),
});
export type PullRequestRecord = z.infer<typeof pullRequestRecordSchema>;

/** What CI said about a fix: its failed jobs, redacted (agent-core), for the retry's brief. */
export const retryFeedbackSchema = z
  .array(
    z.strictObject({
      /** The workflow the job ran in: it has to pass again before a later fix is verified. */
      workflowId: z
        .string()
        .regex(/^[0-9]{1,20}$/)
        .optional(),
      name: z.string().max(500),
      failedStep: z.string().max(500).nullable(),
      summary: z.string().max(2_000).nullable(),
      errorWindow: z.string().max(200_000),
    }),
  )
  .max(10);

/** The claim on a retry after failed CI (P5.3d): the check to reproduce and the caps. */
export const retryClaimSchema = z.strictObject({
  previousAttemptId: z.uuid(),
  failingCheck: z.enum(["install", "build", "lint", "typecheck", "test"]),
  feedback: retryFeedbackSchema,
  maxAttemptsPerFailure: z.int().min(1).max(100),
  maxAttemptsPerDay: z.int().min(1).max(10_000),
});
export type RetryClaimInput = z.input<typeof retryClaimSchema>;

/** CI's answer about an attempt's pull request (P5.3). */
export const verificationSchema = z.strictObject({
  result: z.enum(["verified", "failed", "unverified"]),
  /** PipeHeal's own words, shown on the dashboard. */
  reason: z.string().trim().min(1).max(300).optional(),
  /** The CI evidence the answer rests on (`HealAttempt.ciSeen`). */
  seen: z.int().min(0).max(1_000_000).optional(),
});
export type VerificationInput = z.input<typeof verificationSchema>;

/** A dispatch that didn't produce a healer run the attempt can be bound to. */
export const dispatchFailureSchema = z.strictObject({
  reason: z.string().trim().min(1).max(300),
  /** NEEDS_SETUP when the healer workflow is missing or can't be dispatched. */
  failureStatus: z.enum(["FAILED", "NEEDS_SETUP"]),
});
export type DispatchFailureInput = z.input<typeof dispatchFailureSchema>;

/** A repository's configured commands (SPEC §7.2) and JUnit glob (§8.6), as an admin sets them. */
export const repositoryCommandsSchema = z.strictObject({
  commands: attemptCommandsSchema,
  junitGlob: z.string().trim().min(1).max(512).nullable(),
});
export type RepositoryCommandsInput = z.input<typeof repositoryCommandsSchema>;
