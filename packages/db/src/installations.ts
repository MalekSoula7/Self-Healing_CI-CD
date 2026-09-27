// Tenants come from GitHub App installations (SPEC §5.1, §10). These helpers act on verified
// input only: signed webhooks (worker) and sign-ins GitHub confirmed (web, OWNER binding). They
// are the only way an Organization row is created or changes status, and an OWNER is bound.
import { z } from "zod";
import { auditTarget, writeAudit, type Actor } from "./audit";
import type { Db } from "./client";
import type { OrgStatus } from "./generated/prisma/enums";
import { githubIdSchema, installationInputSchema, type InstallationInput } from "./inputs";

const ownerClaimSchema = z.strictObject({
  userId: z.string().min(1),
  /** The user's GitHub ID (Better Auth's Account.accountId for the github provider). */
  githubUserId: githubIdSchema,
});
export type OwnerClaim = z.infer<typeof ownerClaimSchema>;

const ownerEvidenceSchema = z.strictObject({
  /** Installations GitHub lists for the user's own token (`GET /user/installations`). */
  installationIds: z.array(githubIdSchema),
  /** Organizations where GitHub says the user is an active admin (`GET /user/memberships/orgs`). */
  adminOrgIds: z.array(githubIdSchema),
});
/** What GitHub confirmed, with the user's own token, at sign-in (SPEC §5.2, D10). */
export type OwnerEvidence = z.infer<typeof ownerEvidenceSchema>;

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

    /**
     * Active organizations this GitHub user installed the App on and isn't a member of yet: the
     * OWNER candidates of SPEC §5.2. Empty for almost every sign-in, so callers only ask GitHub
     * for the user's installations when this isn't.
     */
    async ownerCandidates(claim: OwnerClaim) {
      const { userId, githubUserId } = ownerClaimSchema.parse(claim);
      return db.organization.findMany({
        where: {
          installerGithubId: githubUserId,
          status: "ACTIVE",
          memberships: { none: { userId } },
        },
        select: { id: true, installationId: true, accountType: true },
      });
    },

    /**
     * Makes the user OWNER of each candidate organization (they installed the App there) that
     * GitHub vouches for with the user's own token (SPEC §5.2, D10):
     * - GitHub lists the installation as accessible to them, and
     * - a personal account is their own account; an organization lists them as an active admin.
     * Installing alone isn't enough: a repository admin can install an App on an org's repos.
     * Returns the org IDs bound.
     */
    async bindVerifiedOwner(claim: OwnerClaim, evidence: OwnerEvidence) {
      const { userId, githubUserId } = ownerClaimSchema.parse(claim);
      const { installationIds, adminOrgIds } = ownerEvidenceSchema.parse(evidence);
      return db.$transaction(async (tx) => {
        const orgs = await tx.organization.findMany({
          where: {
            installerGithubId: githubUserId,
            installationId: { in: installationIds },
            status: "ACTIVE",
            memberships: { none: { userId } },
            OR: [
              { accountType: "USER", githubAccountId: githubUserId },
              { accountType: "ORG", githubAccountId: { in: adminOrgIds } },
            ],
          },
          select: { id: true },
        });
        for (const { id } of orgs) {
          await tx.membership.create({ data: { orgId: id, userId, role: "OWNER" } });
          // The candidate is used up: removing this owner later must not let them back in at
          // their next sign-in. A reinstall names a new candidate.
          await tx.organization.update({ where: { id }, data: { installerGithubId: null } });
          await writeAudit(tx, id, actor, {
            action: "member.owner_verified",
            target: auditTarget("user", userId),
            metadata: { githubUserId: String(githubUserId) },
          });
        }
        return orgs.map((org) => org.id);
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
