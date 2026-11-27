// @pipeheal/db: Prisma + PostgreSQL, plus org-scoped data helpers.
// Tenant-owned tables are read and written through `forMember` / `forSystem` / `installations` /
// `runnerSessions` only (CLAUDE.md). The raw client from `createDb` is for Better Auth's adapter and these helpers.
export type { Actor } from "./audit";
export { createDb, type Db } from "./client";
export { ConflictError, ForbiddenError, NotFoundError } from "./errors";
export type {
  AttemptInput,
  DispatchClaimInput,
  DispatchFailureInput,
  FailureSettleInput,
  RepositoryCommandsInput,
  AuditPage,
  FailedJobInput,
  FailedRunInput,
  FailurePage,
  InstallationInput,
  PassedRunInput,
  RecentChangesInput,
  RecentChangesRecord,
  InstalledRepository,
  InstalledWorkflow,
  ClassificationInput,
  JobSignals,
  JobTriageInput,
  ModelCallInput,
  PolicyFileRecord,
  TriageCategory,
  WebhookDeliveryInput,
} from "./inputs";
export {
  failureStatusSchema,
  jobSignalsSchema,
  jobTriageInputSchema,
  MAX_POLICY_FILE_ERRORS,
  policyFileRecordSchema,
  recentChangesRecordSchema,
  fixSummarySchema,
  submissionValidationSchema,
  testInventoryRecordSchema,
  type FixSummary,
  type PullRequestRecord,
  type SubmissionValidation,
  type TestInventoryRecord,
} from "./inputs";
export {
  installations,
  type Installations,
  type OwnerClaim,
  type OwnerEvidence,
} from "./installations";
export {
  COLLECTION_WINDOW_MS,
  SYNC_BATCH_LIMIT,
  forMember,
  forSystem,
  hasRole,
  organizationsOf,
  type OrgScope,
  type CompiledRuleRecord,
  type OrgSummary,
  type StoredLayers,
  type SystemScope,
} from "./scope";
export type {
  StepAcceptance,
  StepInput,
  StepOutcome,
  StepView,
  SubmissionInput,
  TurnInput,
} from "./attempt-steps";
export {
  DISPATCH_TIMEOUT_MS,
  SESSION_TTL_MS,
  runnerSessions,
  type AttemptForSession,
  type RunnerSessions,
  type SessionRef,
} from "./runner-sessions";
export { DEV_DATABASE_URL, databaseUrlSchema, tlsUnlessLoopback } from "./url";
export { GITHUB_PROVIDER_ID, githubIdentity, type GitHubIdentity } from "./users";
export {
  installationDeliveryState,
  markWebhookDeliveryFailed,
  type InstallationDeliveryState,
  markWebhookDeliveryProcessed,
  recordWebhookDelivery,
  type RecordedDelivery,
} from "./webhook-deliveries";
export * from "./generated/prisma/enums";
export {
  Prisma,
  type Account,
  type AgentEvent,
  type AgentStep,
  type AuditLog,
  type FailedJob,
  type FailedRun,
  type Membership,
  type ModelCall,
  type Organization,
  type PipelineFailure,
  type RepoWorkflow,
  type Repository,
  type Session,
  type User,
  type Verification,
  type WebhookDelivery,
} from "./generated/prisma/client";
