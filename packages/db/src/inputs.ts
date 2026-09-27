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
});
export type InstalledWorkflow = z.infer<typeof installedWorkflowSchema>;

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
