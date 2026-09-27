// Tenants come from GitHub App installations (SPEC §5.1, §10). These helpers run in the worker on
// verified webhooks and are the only way an Organization row is created or changes status.
import { auditTarget, writeAudit, type Actor } from "./audit";
import type { Db } from "./client";
import type { OrgStatus } from "./generated/prisma/enums";
import { githubIdSchema, installationInputSchema, type InstallationInput } from "./inputs";

const STATUS_ACTIONS: Record<OrgStatus, string> = {
  ACTIVE: "organization.activated",
  SUSPENDED: "organization.suspended",
  UNINSTALLED: "organization.uninstalled",
};

/** `component` names the caller in the audit log (e.g. "webhook"). */
export function installations(db: Db, component: string) {
  const actor: Actor = { type: "SYSTEM", component };

  return {
    async findByInstallationId(installationId: bigint) {
      const parsed = githubIdSchema.safeParse(installationId);
      if (!parsed.success) return null;
      return db.organization.findUnique({ where: { installationId: parsed.data } });
    },

    /**
     * Creates the tenant for a new installation, or updates it (reinstall, new installation ID,
     * renamed login). The organization becomes ACTIVE.
     */
    async upsert(input: InstallationInput) {
      const data = installationInputSchema.parse(input);
      const slug = data.login.toLowerCase();
      return db.$transaction(async (tx) => {
        const existing = await tx.organization.findUnique({
          where: { githubAccountId: data.githubAccountId },
        });
        if (existing === null) {
          const created = await tx.organization.create({ data: { ...data, slug } });
          await writeAudit(tx, created.id, actor, {
            action: "organization.installed",
            target: auditTarget("organization", created.id),
            metadata: { installationId: String(created.installationId) },
          });
          return created;
        }

        const reinstalled =
          existing.status === "UNINSTALLED" || existing.installationId !== data.installationId;
        const changed =
          reinstalled ||
          existing.status !== "ACTIVE" ||
          existing.login !== data.login ||
          existing.accountType !== data.accountType ||
          (data.installerGithubId !== undefined &&
            existing.installerGithubId !== data.installerGithubId);
        if (!changed) return existing;

        const updated = await tx.organization.update({
          where: { id: existing.id },
          data: {
            login: data.login,
            slug,
            accountType: data.accountType,
            installationId: data.installationId,
            installerGithubId: data.installerGithubId ?? existing.installerGithubId,
            status: "ACTIVE",
          },
        });
        await writeAudit(tx, existing.id, actor, {
          action: reinstalled ? "organization.reinstalled" : "organization.updated",
          target: auditTarget("organization", existing.id),
          metadata: { installationId: String(updated.installationId) },
        });
        return updated;
      });
    },

    /** Suspend, unsuspend or uninstall. Returns null for an unknown installation. */
    async setStatus(installationId: bigint, status: OrgStatus) {
      const id = githubIdSchema.parse(installationId);
      return db.$transaction(async (tx) => {
        const org = await tx.organization.findUnique({ where: { installationId: id } });
        if (org === null || org.status === status) return org;
        const updated = await tx.organization.update({ where: { id: org.id }, data: { status } });
        await writeAudit(tx, org.id, actor, {
          action: STATUS_ACTIONS[status],
          target: auditTarget("organization", org.id),
          metadata: { from: org.status, to: status },
        });
        return updated;
      });
    },
  };
}

export type Installations = ReturnType<typeof installations>;
