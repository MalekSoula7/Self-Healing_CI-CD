// Org-scoped data access. CLAUDE.md: every query on a tenant-owned table goes through here.
//
// - Every query filters on the scope's orgId. An ID from another org behaves exactly like an ID
//   that does not exist (null on reads, NotFoundError on writes), so callers can't tell them apart.
// - Roles are checked here too, not only in the web layer (SPEC §11 RBAC): MEMBER reads,
//   ADMIN changes repositories and workflows. SYSTEM (the worker) acts with OWNER rights.
// - Every mutation writes its audit row in the same transaction. A no-op writes nothing.
import { z } from "zod";
import { auditChanges, auditTarget, writeAudit, type Actor } from "./audit";
import type { Db } from "./client";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors";
import type { RepoWorkflow } from "./generated/prisma/client";
import type { AccountType, OrgStatus, Role } from "./generated/prisma/enums";
import {
  auditPageSchema,
  githubIdSchema,
  idSchema,
  installedRepositorySchema,
  installedWorkflowSchema,
  type AuditPage,
  type InstalledRepository,
  type InstalledWorkflow,
} from "./inputs";

export interface OrgSummary {
  id: string;
  slug: string;
  login: string;
  accountType: AccountType;
  status: OrgStatus;
}

const ORG_SUMMARY = {
  id: true,
  slug: true,
  login: true,
  accountType: true,
  status: true,
} as const;

const ROLE_RANK: Record<Role, number> = { MEMBER: 0, ADMIN: 1, OWNER: 2 };

export function hasRole(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/** Batch limit for installation syncs: callers split larger lists (one transaction per batch). */
export const SYNC_BATCH_LIMIT = 100;

interface ScopeContext {
  db: Db;
  org: OrgSummary;
  role: Role;
  actor: Actor;
}

/** A malformed ID can't name a row in this org: treat it like an unknown one. */
function parseId(value: string): string | null {
  const parsed = idSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function requireId(value: string, kind: string): string {
  const id = parseId(value);
  if (id === null) throw new NotFoundError(`${kind} not found`);
  return id;
}

/** Trigger names come from the workflow file's own `on:` order, stable across identical content. */
function triggersEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((trigger, index) => trigger === b[index]);
}

/** What a workflow sync can change, as recorded in its audit entry (never `selected`). */
function workflowFacts(workflow: RepoWorkflow) {
  return {
    path: workflow.path,
    name: workflow.name,
    triggers: workflow.triggers,
    usesEnvironment: workflow.usesEnvironment,
  };
}

function requireRole(ctx: ScopeContext, minimum: Role): void {
  if (!hasRole(ctx.role, minimum)) throw new ForbiddenError(`requires the ${minimum} role`);
}

function buildOrgScope(ctx: ScopeContext) {
  const { db, org, actor } = ctx;
  const orgId = org.id;

  return {
    org,
    role: ctx.role,

    repositories: {
      /** Repositories currently in the installation, by name. */
      list() {
        return db.repository.findMany({
          where: { orgId, removedFromInstallationAt: null },
          orderBy: { fullName: "asc" },
        });
      },

      /** Also returns repositories removed from the installation (their history stays visible). */
      async get(repoId: string) {
        const id = parseId(repoId);
        return id === null ? null : db.repository.findFirst({ where: { id, orgId } });
      },

      async setEnabled(repoId: string, enabled: boolean) {
        requireRole(ctx, "ADMIN");
        const id = requireId(repoId, "repository");
        return db.$transaction(async (tx) => {
          const repo = await tx.repository.findFirst({ where: { id, orgId } });
          if (repo === null) throw new NotFoundError("repository not found");
          if (enabled && repo.removedFromInstallationAt !== null) {
            throw new ConflictError("repository is no longer in the installation");
          }
          if (repo.enabled === enabled) return repo;
          const updated = await tx.repository.update({ where: { id, orgId }, data: { enabled } });
          await writeAudit(tx, orgId, actor, {
            action: enabled ? "repository.enabled" : "repository.disabled",
            target: auditTarget("repository", id),
          });
          return updated;
        });
      },
    },

    workflows: {
      async listForRepo(repoId: string) {
        const id = parseId(repoId);
        if (id === null) return [];
        return db.repoWorkflow.findMany({ where: { orgId, repoId: id }, orderBy: { path: "asc" } });
      },

      async setSelected(workflowId: string, selected: boolean) {
        requireRole(ctx, "ADMIN");
        const id = requireId(workflowId, "workflow");
        return db.$transaction(async (tx) => {
          const workflow = await tx.repoWorkflow.findFirst({ where: { id, orgId } });
          if (workflow === null) throw new NotFoundError("workflow not found");
          if (workflow.selected === selected) return workflow;
          const updated = await tx.repoWorkflow.update({
            where: { id, orgId },
            data: { selected },
          });
          await writeAudit(tx, orgId, actor, {
            action: selected ? "workflow.selected" : "workflow.deselected",
            target: auditTarget("workflow", id),
            metadata: { repoId: workflow.repoId },
          });
          return updated;
        });
      },
    },

    members: {
      /** Members with their public profile (no emails). */
      list() {
        return db.membership.findMany({
          where: { orgId },
          orderBy: { createdAt: "asc" },
          select: {
            role: true,
            createdAt: true,
            user: { select: { id: true, name: true, login: true, image: true } },
          },
        });
      },
    },

    audit: {
      /** Newest first. */
      list(page: AuditPage = {}) {
        const { take, before } = auditPageSchema.parse(page);
        return db.auditLog.findMany({
          where: { orgId, ...(before === undefined ? {} : { id: { lt: before } }) },
          orderBy: { id: "desc" },
          take,
        });
      },
    },
  };
}

/** What a signed-in member can do in their organization. */
export type OrgScope = ReturnType<typeof buildOrgScope>;

function buildSystemScope(ctx: ScopeContext) {
  const base = buildOrgScope(ctx);
  const { db, actor } = ctx;
  const orgId = ctx.org.id;

  return {
    ...base,
    repositories: {
      ...base.repositories,

      async findByGithubId(githubRepoId: bigint) {
        const parsed = githubIdSchema.safeParse(githubRepoId);
        if (!parsed.success) return null;
        return db.repository.findUnique({
          where: { orgId_githubRepoId: { orgId, githubRepoId: parsed.data } },
        });
      },

      /**
       * Upserts repositories reported by GitHub for this org's installation (at most
       * SYNC_BATCH_LIMIT). New ones start disabled; re-added ones stay disabled until an admin
       * enables them again.
       */
      async syncInstalled(repositories: readonly InstalledRepository[]) {
        const repos = z.array(installedRepositorySchema).max(SYNC_BATCH_LIMIT).parse(repositories);
        return db.$transaction(async (tx) => {
          const results = [];
          for (const repo of repos) {
            const existing = await tx.repository.findUnique({
              where: { orgId_githubRepoId: { orgId, githubRepoId: repo.githubRepoId } },
            });
            if (existing === null) {
              const created = await tx.repository.create({ data: { orgId, ...repo } });
              await writeAudit(tx, orgId, actor, {
                action: "repository.added",
                target: auditTarget("repository", created.id),
                metadata: { fullName: created.fullName },
              });
              results.push(created);
              continue;
            }
            const readded = existing.removedFromInstallationAt !== null;
            const changed =
              readded ||
              existing.fullName !== repo.fullName ||
              existing.defaultBranch !== repo.defaultBranch;
            if (!changed) {
              results.push(existing);
              continue;
            }
            const updated = await tx.repository.update({
              where: { id: existing.id, orgId },
              data: {
                fullName: repo.fullName,
                defaultBranch: repo.defaultBranch,
                removedFromInstallationAt: null,
              },
            });
            await writeAudit(tx, orgId, actor, {
              action: readded ? "repository.readded" : "repository.updated",
              target: auditTarget("repository", existing.id),
              metadata: {
                fullName: updated.fullName,
                changes: auditChanges(
                  { fullName: existing.fullName, defaultBranch: existing.defaultBranch },
                  { fullName: updated.fullName, defaultBranch: updated.defaultBranch },
                ),
              },
            });
            results.push(updated);
          }
          return results;
        });
      },

      /**
       * Marks repositories that left the installation as removed and disables them (at most
       * SYNC_BATCH_LIMIT IDs). Returns how many changed.
       */
      async markRemoved(githubRepoIds: readonly bigint[]) {
        const ids = z.array(githubIdSchema).max(SYNC_BATCH_LIMIT).parse(githubRepoIds);
        return db.$transaction(async (tx) => {
          const repos = await tx.repository.findMany({
            where: { orgId, githubRepoId: { in: ids }, removedFromInstallationAt: null },
            select: { id: true },
          });
          if (repos.length === 0) return 0;
          await tx.repository.updateMany({
            where: { orgId, id: { in: repos.map((repo) => repo.id) } },
            data: { removedFromInstallationAt: new Date(), enabled: false },
          });
          for (const { id } of repos) {
            await writeAudit(tx, orgId, actor, {
              action: "repository.removed",
              target: auditTarget("repository", id),
            });
          }
          return repos.length;
        });
      },
    },

    workflows: {
      ...base.workflows,

      /**
       * Upserts the workflows GitHub reports for one repository of this org (at most
       * SYNC_BATCH_LIMIT). A newly discovered workflow starts `selected` as given (the
       * "CI-looking" heuristic's suggestion, SPEC §11); once a workflow exists, only the admin's
       * choice on /[org]/repos/[repo] can change it — a later sync never touches `selected`.
       */
      async syncInstalled(repoId: string, workflows: readonly InstalledWorkflow[]) {
        const id = requireId(repoId, "repository");
        const items = z.array(installedWorkflowSchema).max(SYNC_BATCH_LIMIT).parse(workflows);
        return db.$transaction(async (tx) => {
          const repo = await tx.repository.findFirst({ where: { id, orgId } });
          if (repo === null) throw new NotFoundError("repository not found");
          const results = [];
          for (const workflow of items) {
            const existing = await tx.repoWorkflow.findUnique({
              where: {
                repoId_githubWorkflowId: {
                  repoId: id,
                  githubWorkflowId: workflow.githubWorkflowId,
                },
              },
            });
            if (existing === null) {
              const created = await tx.repoWorkflow.create({
                data: { orgId, repoId: id, ...workflow },
              });
              await writeAudit(tx, orgId, actor, {
                action: "workflow.discovered",
                target: auditTarget("workflow", created.id),
                metadata: { repoId: id, path: created.path },
              });
              results.push(created);
              continue;
            }
            const { triggers, usesEnvironment } = workflow;
            const changed =
              existing.path !== workflow.path ||
              existing.name !== workflow.name ||
              (triggers !== undefined && !triggersEqual(existing.triggers, triggers)) ||
              (usesEnvironment !== undefined && existing.usesEnvironment !== usesEnvironment);
            if (!changed) {
              results.push(existing);
              continue;
            }
            const updated = await tx.repoWorkflow.update({
              where: { id: existing.id },
              data: {
                path: workflow.path,
                name: workflow.name,
                ...(triggers === undefined ? {} : { triggers }),
                ...(usesEnvironment === undefined ? {} : { usesEnvironment }),
              },
            });
            await writeAudit(tx, orgId, actor, {
              action: "workflow.updated",
              target: auditTarget("workflow", existing.id),
              metadata: {
                repoId: id,
                path: updated.path,
                changes: auditChanges(workflowFacts(existing), workflowFacts(updated)),
              },
            });
            results.push(updated);
          }
          return results;
        });
      },
    },
  };
}

/** What the worker can do in one organization. */
export type SystemScope = ReturnType<typeof buildSystemScope>;

/**
 * The scope of a signed-in user in the organization with this slug (the `[org]` URL segment),
 * or null when the organization doesn't exist or the user isn't a member: callers answer 404
 * for both, so non-members learn nothing.
 */
export async function forMember(
  db: Db,
  { orgSlug, userId }: { orgSlug: string; userId: string },
): Promise<OrgScope | null> {
  const membership = await db.membership.findFirst({
    where: { userId, org: { slug: orgSlug.toLowerCase() } },
    select: { role: true, org: { select: ORG_SUMMARY } },
  });
  if (membership === null) return null;
  return buildOrgScope({
    db,
    org: membership.org,
    role: membership.role,
    actor: { type: "USER", userId },
  });
}

/**
 * The worker's scope in one organization. The caller resolved `orgId` from verified input
 * (a signed webhook's installation ID); `component` names the caller in the audit log.
 */
export async function forSystem(db: Db, orgId: string, component: string): Promise<SystemScope> {
  const id = requireId(orgId, "organization");
  const org = await db.organization.findUnique({ where: { id }, select: ORG_SUMMARY });
  if (org === null) throw new NotFoundError("organization not found");
  return buildSystemScope({ db, org, role: "OWNER", actor: { type: "SYSTEM", component } });
}

/** The organizations a user belongs to, with their role in each (for org switchers). */
export async function organizationsOf(db: Db, userId: string) {
  return db.membership.findMany({
    where: { userId },
    select: { role: true, org: { select: ORG_SUMMARY } },
    orderBy: { org: { slug: "asc" } },
  });
}
