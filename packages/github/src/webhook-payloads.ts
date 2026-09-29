// zod schemas for the `installation` and `installation_repositories` webhook payloads (SPEC
// §5.1, §10). GitHub's real payloads carry many more fields than these; a plain `z.object()`
// (not `z.strictObject()`) keeps only what we use and ignores the rest, so a new GitHub field
// never breaks parsing.
import { z } from "zod";
import { toWorkflowRun, workflowRunSchema } from "./repo";

const id = z.number().int().positive().transform(BigInt);

const accountSchema = z.object({
  id,
  login: z.string().min(1),
  type: z.enum(["Organization", "User"]),
});

const installationRefSchema = z.object({ id, account: accountSchema });

const senderSchema = z.object({ id, login: z.string().min(1) });

const repoRefSchema = z.object({ id, full_name: z.string().min(1) });
export type WebhookRepoRef = z.infer<typeof repoRefSchema>;

/**
 * `installation` event (SPEC §5.1): install, uninstall, suspend, unsuspend, permissions
 * accepted. `repositories` is present (possibly empty) only on `created`.
 */
export const installationEventSchema = z.object({
  action: z.string(),
  installation: installationRefSchema,
  sender: senderSchema,
  repositories: z.array(repoRefSchema).optional(),
});
export type InstallationEvent = z.infer<typeof installationEventSchema>;

/** `installation_repositories` event: repositories added to or removed from an installation. */
export const installationRepositoriesEventSchema = z.object({
  action: z.enum(["added", "removed"]),
  installation: installationRefSchema,
  repositories_added: z.array(repoRefSchema).default([]),
  repositories_removed: z.array(repoRefSchema).default([]),
});
export type InstallationRepositoriesEvent = z.infer<typeof installationRepositoriesEventSchema>;

/**
 * `workflow_run` event (SPEC §2 steps 2 and 4). The run is parsed and mapped exactly like one
 * from the API (`RepoClient.getRun`), so `fromFork` is decided the same way: by repository ID.
 */
export const workflowRunEventSchema = z.object({
  action: z.string(),
  installation: z.object({ id }),
  repository: repoRefSchema,
  workflow_run: workflowRunSchema.transform(toWorkflowRun),
});
export type WorkflowRunEvent = z.infer<typeof workflowRunEventSchema>;

/** GitHub's account `type` as our `Organization.accountType` (SPEC §10). */
export function toAccountType(type: "Organization" | "User"): "ORG" | "USER" {
  return type === "Organization" ? "ORG" : "USER";
}
