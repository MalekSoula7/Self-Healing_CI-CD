// zod schemas for everything the data helpers accept from callers (CLAUDE.md: validate every
// external input). Callers pass values that came from users, webhooks or the GitHub API.
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
export const jobTriageInputSchema = z.strictObject({
  errorWindow: z.string().max(200_000),
  redactions: z.record(z.string().regex(/^[a-z-]{1,40}$/), z.int().nonnegative()).optional(),
});
export type JobTriageInput = z.infer<typeof jobTriageInputSchema>;

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

export const auditPageSchema = z.strictObject({
  take: z.int().min(1).max(200).default(50),
  /**
   * Return entries older than this audit entry ID. IDs are UUIDv7: time-ordered, and Prisma
   * generates them monotonically within a process (checked in P1.2), so ID order is write order.
   */
  before: idSchema.optional(),
});
export type AuditPage = z.input<typeof auditPageSchema>;
