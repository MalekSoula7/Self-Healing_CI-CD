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
import type { AccountType, FailureStatus, OrgStatus, Role } from "./generated/prisma/enums";
import {
  auditPageSchema,
  failedRunInputSchema,
  githubIdSchema,
  idSchema,
  installedRepositorySchema,
  installedWorkflowSchema,
  jobTriageInputSchema,
  passedRunInputSchema,
  type AuditPage,
  type FailedRunInput,
  type InstalledRepository,
  type InstalledWorkflow,
  type JobTriageInput,
  type PassedRunInput,
} from "./inputs";

/** SPEC §2.1: the first failed run for a commit opens a window this long to collect the rest. */
export const COLLECTION_WINDOW_MS = 5 * 60 * 1000;

/** Nothing was dispatched for a failure in these states, so passing re-runs can still make it FLAKY. */
const NOT_DISPATCHED: readonly FailureStatus[] = ["DETECTED", "TRIAGED", "SKIPPED", "NEEDS_SETUP"];

const FAILURE_WITH_RUNS = {
  runs: { include: { jobs: true }, orderBy: { createdAt: "asc" } },
} as const;

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

    failures: {
      /** A failure with its runs and their jobs, oldest run first. */
      async get(failureId: string) {
        const id = parseId(failureId);
        return id === null
          ? null
          : db.pipelineFailure.findFirst({ where: { id, orgId }, include: FAILURE_WITH_RUNS });
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

    failures: {
      ...base.failures,

      /** The failure for this commit of the repository, if there is one. */
      async findBySha(repoId: string, headSha: string) {
        const id = parseId(repoId);
        if (id === null || !/^[0-9a-f]{40}$/.test(headSha)) return null;
        return db.pipelineFailure.findFirst({
          where: { orgId, repoId: id, headSha },
          include: FAILURE_WITH_RUNS,
        });
      },

      /**
       * Attaches a failed run to its commit's failure (SPEC §2.1), opening the failure and its
       * collection window if it's the commit's first. A known run is updated only by a newer
       * attempt, whose failed jobs replace the old attempt's. Safe under concurrent and repeated
       * deliveries: inserts that lose a race do nothing, and the row is read back.
       */
      async recordFailedRun(
        repoId: string,
        input: FailedRunInput,
        windowMs: number = COLLECTION_WINDOW_MS,
      ) {
        const id = requireId(repoId, "repository");
        const { jobs, headSha, headBranch, ...run } = failedRunInputSchema.parse(input);
        return db.$transaction(async (tx) => {
          const repo = await tx.repository.findFirst({ where: { id, orgId } });
          if (repo === null) throw new NotFoundError("repository not found");

          const opened = await tx.pipelineFailure.createMany({
            data: [
              {
                orgId,
                repoId: id,
                headSha,
                headBranch,
                windowClosesAt: new Date(Date.now() + windowMs),
              },
            ],
            skipDuplicates: true,
          });
          const failure = await tx.pipelineFailure.findUniqueOrThrow({
            where: { repoId_headSha: { repoId: id, headSha } },
          });
          const lateArrival = failure.windowClosedAt !== null;
          const inserted = await tx.failedRun.createMany({
            data: [{ orgId, repoId: id, failureId: failure.id, lateArrival, ...run }],
            skipDuplicates: true,
          });
          const existing = await tx.failedRun.findUniqueOrThrow({
            where: { repoId_runId: { repoId: id, runId: run.runId } },
          });
          const metadata = {
            runId: String(run.runId),
            runAttempt: run.runAttempt,
            workflowPath: run.workflowPath,
          };

          if (inserted.count === 1) {
            await tx.failedJob.createMany({
              data: jobs.map((job) => ({ orgId, failedRunId: existing.id, ...job })),
              skipDuplicates: true,
            });
            await writeAudit(tx, orgId, actor, {
              action: opened.count === 1 ? "failure.detected" : "failure.run_attached",
              target: auditTarget("failure", failure.id),
              metadata: { ...metadata, headSha, lateArrival },
            });
            return {
              failure,
              run: existing,
              outcome: opened.count === 1 ? ("opened" as const) : ("attached" as const),
            };
          }

          if (run.runAttempt <= existing.runAttempt) {
            return { failure, run: existing, outcome: "unchanged" as const };
          }
          const updated = await tx.failedRun.update({
            where: { id: existing.id },
            data: { runAttempt: run.runAttempt, conclusion: run.conclusion, htmlUrl: run.htmlUrl },
          });
          await tx.failedJob.deleteMany({ where: { orgId, failedRunId: existing.id } });
          await tx.failedJob.createMany({
            data: jobs.map((job) => ({ orgId, failedRunId: existing.id, ...job })),
            skipDuplicates: true,
          });
          await writeAudit(tx, orgId, actor, {
            action: "failure.run_updated",
            target: auditTarget("failure", failure.id),
            metadata,
          });
          return { failure, run: updated, outcome: "updated" as const };
        });
      },

      /**
       * A newer attempt of a failed run passed (SPEC §2.1 re-runs). When every run of a failure
       * that hasn't been dispatched has passed, the failure is FLAKY. Null for a run we don't
       * track (it never failed).
       */
      async recordPassedRun(repoId: string, input: PassedRunInput) {
        const id = requireId(repoId, "repository");
        const { runId, runAttempt } = passedRunInputSchema.parse(input);
        return db.$transaction(async (tx) => {
          const repo = await tx.repository.findFirst({ where: { id, orgId } });
          if (repo === null) throw new NotFoundError("repository not found");
          const run = await tx.failedRun.findUnique({
            where: { repoId_runId: { repoId: id, runId } },
          });
          if (run === null) return null;
          const failure = await tx.pipelineFailure.findUniqueOrThrow({
            where: { orgId_id: { orgId, id: run.failureId } },
          });
          if (runAttempt <= run.runAttempt) return { failure, outcome: "unchanged" as const };

          await tx.failedRun.update({
            where: { id: run.id },
            data: { runAttempt, conclusion: "success" },
          });
          await writeAudit(tx, orgId, actor, {
            action: "failure.run_passed",
            target: auditTarget("failure", failure.id),
            metadata: { runId: String(runId), runAttempt },
          });
          const failing = await tx.failedRun.count({
            where: { orgId, failureId: failure.id, conclusion: { not: "success" } },
          });
          if (failing > 0 || !NOT_DISPATCHED.includes(failure.status)) {
            return { failure, outcome: "passed" as const };
          }
          const flaky = await tx.pipelineFailure.update({
            where: { id: failure.id },
            data: { status: "FLAKY" },
          });
          await writeAudit(tx, orgId, actor, {
            action: "failure.flaky",
            target: auditTarget("failure", failure.id),
            metadata: { from: failure.status, to: "FLAKY" },
          });
          return { failure: flaky, outcome: "flaky" as const };
        });
      },

      /** Stores what triage found for one failed job (SPEC §6.2). */
      async recordJobTriage(failedJobId: string, input: JobTriageInput) {
        const id = requireId(failedJobId, "failed job");
        const { errorWindow, signals, redactions } = jobTriageInputSchema.parse(input);
        return db.$transaction(async (tx) => {
          const job = await tx.failedJob.findFirst({
            where: { id, orgId },
            include: { failedRun: { select: { failureId: true } } },
          });
          if (job === null) throw new NotFoundError("failed job not found");
          const updated = await tx.failedJob.update({
            where: { id },
            data: { errorWindow, ...(signals === undefined ? {} : { signals }) },
          });
          await writeAudit(tx, orgId, actor, {
            action: "failure.job_triaged",
            target: auditTarget("failure", job.failedRun.failureId),
            metadata: {
              failedJobId: id,
              githubJobId: String(job.githubJobId),
              ...(redactions === undefined ? {} : { redactions }),
            },
          });
          return updated;
        });
      },

      /** Closes the collection window now (SPEC §2.1). Later runs are late arrivals. */
      async closeWindow(failureId: string) {
        const id = requireId(failureId, "failure");
        return db.$transaction(async (tx) => {
          const failure = await tx.pipelineFailure.findFirst({ where: { id, orgId } });
          if (failure === null) throw new NotFoundError("failure not found");
          if (failure.windowClosedAt !== null) return failure;
          const closedAt = new Date();
          const closed = await tx.pipelineFailure.update({
            where: { id },
            data: { windowClosedAt: closedAt },
          });
          await writeAudit(tx, orgId, actor, {
            action: "failure.window_closed",
            target: auditTarget("failure", id),
            metadata: { early: closedAt < failure.windowClosesAt },
          });
          return closed;
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
