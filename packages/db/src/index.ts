// @pipeheal/db: Prisma + PostgreSQL, plus org-scoped data helpers.
// Tenant-owned tables are read and written through `forMember` / `forSystem` / `installations`
// only (CLAUDE.md). The raw client from `createDb` is for Better Auth's adapter and these helpers.
export type { Actor } from "./audit";
export { createDb, type Db } from "./client";
export { ConflictError, ForbiddenError, NotFoundError } from "./errors";
export type { AuditPage, InstallationInput, InstalledRepository } from "./inputs";
export {
  installations,
  type Installations,
  type OwnerClaim,
  type OwnerEvidence,
} from "./installations";
export {
  SYNC_BATCH_LIMIT,
  forMember,
  forSystem,
  hasRole,
  organizationsOf,
  type OrgScope,
  type OrgSummary,
  type SystemScope,
} from "./scope";
export { DEV_DATABASE_URL, databaseUrlSchema, tlsUnlessLoopback } from "./url";
export { GITHUB_PROVIDER_ID, githubIdentity, type GitHubIdentity } from "./users";
export * from "./generated/prisma/enums";
export {
  Prisma,
  type Account,
  type AuditLog,
  type Membership,
  type Organization,
  type RepoWorkflow,
  type Repository,
  type Session,
  type User,
  type Verification,
  type WebhookDelivery,
} from "./generated/prisma/client";
