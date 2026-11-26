// Org-scoped data access. CLAUDE.md: every query on a tenant-owned table goes through here.
//
// - Every query filters on the scope's orgId. An ID from another org behaves exactly like an ID
//   that does not exist (null on reads, NotFoundError on writes), so callers can't tell them apart.
// - Roles are checked here too, not only in the web layer (SPEC §11 RBAC): MEMBER reads,
//   ADMIN changes repositories and workflows. SYSTEM (the worker) acts with OWNER rights.
// - Every mutation writes its audit row in the same transaction. A no-op writes nothing.
import { policyLayerSchema, type PolicyLayer } from "@pipeheal/policy";
import { z } from "zod";
import { auditChanges, auditTarget, writeAudit, type Actor } from "./audit";
import type { Db } from "./client";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors";
import { Prisma, type RepoWorkflow } from "./generated/prisma/client";
import type {
  AccountType,
  FailureCategory,
  FailureStatus,
  OrgStatus,
  PolicyKind,
  Role,
} from "./generated/prisma/enums";
import {
  attemptInputSchema,
  auditPageSchema,
  classificationSchema,
  failedRunInputSchema,
  failurePageSchema,
  githubIdSchema,
  idSchema,
  installedRepositorySchema,
  installedWorkflowSchema,
  jobTriageInputSchema,
  modelCallInputSchema,
  passedRunInputSchema,
  policyFileRecordSchema,
  recentChangesRecordSchema,
  type AttemptInput,
  type AuditPage,
  type ClassificationInput,
  type FailedRunInput,
  type FailurePage,
  type InstalledRepository,
  type InstalledWorkflow,
  type JobTriageInput,
  type ModelCallInput,
  type PolicyFileRecord,
  type PassedRunInput,
  type RecentChangesRecord,
  type TriageCategory,
} from "./inputs";

/** Triage's category names (SPEC §6.1) as the database enum. */
function toCategory(category: TriageCategory): FailureCategory {
  return category.toUpperCase() as FailureCategory;
}

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

const ruleTextSchema = z.string().trim().min(1).max(1_000);

/** A compiled layer: a policy layer without custom rules of its own (packages/policy's rule). */
const compiledLayerSchema = policyLayerSchema
  .refine((layer) => layer.customRules === undefined, {
    message: "a compiled rule can't hold custom rules",
  })
  .refine((layer) => Object.keys(layer).length > 0, {
    message: "a compiled rule must set something",
  });

/** Rules waiting for the model, per organization. */
export const MAX_PENDING_DRAFTS = 5;

const compiledRuleRecordSchema = z.union([
  z.strictObject({
    compiled: compiledLayerSchema.nullable(),
    explanation: z.string().min(1).max(600),
  }),
  z.strictObject({ error: z.string().min(1).max(300) }),
]);
export type CompiledRuleRecord = z.input<typeof compiledRuleRecordSchema>;

/** A new version of a layer, with its audit entry (in the caller's transaction). */
async function appendPolicyVersion(
  tx: Prisma.TransactionClient,
  ctx: ScopeContext,
  kind: PolicyKind,
  target: string,
  layer: PolicyLayer,
) {
  const orgId = ctx.org.id;
  const latest = await tx.policyVersion.findFirst({
    where: { orgId, kind, target },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const version = (latest?.version ?? 0) + 1;
  const saved = await tx.policyVersion.create({
    data: {
      orgId,
      kind,
      repoId: kind === "REPO" ? target : null,
      target,
      version,
      rules: layer,
      createdById: ctx.actor.type === "USER" ? ctx.actor.userId : null,
    },
  });
  await writeAudit(tx, orgId, ctx.actor, {
    action: "policy.saved",
    target: auditTarget("policy", saved.id),
    // The sections set, not the rules themselves.
    metadata: { kind, repoId: saved.repoId, version, sections: Object.keys(layer).sort() },
  });
  return saved;
}

/** The stored policy layers for packages/policy's `effectivePolicy`. */
export interface StoredLayers {
  orgDefaults?: PolicyLayer | undefined;
  orgGuardrails?: PolicyLayer | undefined;
  repo?: PolicyLayer | undefined;
  repoFile?: PolicyLayer | undefined;
}

/**
 * Which version sequence a layer lives in: "org" for the org-wide kinds, the repository's ID for
 * REPO (null when it isn't one of this org's repositories, or is given for an org-wide kind).
 */
async function policyTarget(
  db: Pick<Db, "repository">,
  orgId: string,
  kind: PolicyKind,
  repoId: string | null,
): Promise<string | null> {
  if (kind !== "REPO") return repoId === null ? "org" : null;
  const id = repoId === null ? null : parseId(repoId);
  if (id === null) return null;
  const repo = await db.repository.findFirst({ where: { id, orgId }, select: { id: true } });
  return repo?.id ?? null;
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

    policies: {
      /** The current version of a policy layer, or null when none was saved. */
      async current(kind: PolicyKind, repoId: string | null = null) {
        const target = await policyTarget(db, orgId, kind, repoId);
        if (target === null) return null;
        return db.policyVersion.findFirst({
          where: { orgId, kind, target },
          orderBy: { version: "desc" },
        });
      },

      /**
       * The stored layers that make a repository's effective policy (SPEC §8.1): org defaults and
       * guardrails, and for a repository its dashboard settings and its `.pipeheal.yml`. Each is
       * re-validated; a layer never saved is absent. `repoId` null: the org-wide layers only.
       */
      async layers(repoId: string | null = null): Promise<StoredLayers> {
        const latest = async (kind: PolicyKind, target: string) => {
          const row = await db.policyVersion.findFirst({
            where: { orgId, kind, target },
            orderBy: { version: "desc" },
            select: { rules: true },
          });
          return row === null ? undefined : policyLayerSchema.parse(row.rules);
        };
        const layers: StoredLayers = {
          orgDefaults: await latest("ORG_DEFAULT", "org"),
          orgGuardrails: await latest("ORG_GUARDRAIL", "org"),
        };
        if (repoId === null) return layers;
        const id = parseId(repoId);
        const repo =
          id === null
            ? null
            : await db.repository.findFirst({
                where: { id, orgId },
                select: { id: true, policyFile: true },
              });
        if (repo === null) throw new NotFoundError("repository not found");
        layers.repo = await latest("REPO", repo.id);
        // .pipeheal.yml was validated when it was read; one that failed to parse isn't stored.
        if (repo.policyFile !== null) layers.repoFile = policyLayerSchema.parse(repo.policyFile);
        return layers;
      },

      /** A layer's versions, newest first (SPEC §8.9). */
      async history(kind: PolicyKind, repoId: string | null = null, take = 20) {
        const target = await policyTarget(db, orgId, kind, repoId);
        if (target === null) return [];
        return db.policyVersion.findMany({
          where: { orgId, kind, target },
          orderBy: { version: "desc" },
          take: z.int().min(1).max(100).parse(take),
        });
      },

      /**
       * Saves a new version of a layer. Admins save org defaults and repository settings; only
       * owners save the guardrails, the ceiling for the whole organization. The rules are
       * re-validated with the layer schema whoever calls.
       */
      async save(kind: PolicyKind, repoId: string | null, rules: unknown) {
        requireRole(ctx, kind === "ORG_GUARDRAIL" ? "OWNER" : "ADMIN");
        const layer = policyLayerSchema.parse(rules);
        return db.$transaction(async (tx) => {
          const target = await policyTarget(tx, orgId, kind, repoId);
          if (target === null) throw new NotFoundError("repository not found");
          return appendPolicyVersion(tx, ctx, kind, target, layer);
        });
      },
    },

    customRules: {
      /** A layer's proposed rules not accepted or discarded yet, newest first (P3.9). */
      async drafts(kind: PolicyKind, repoId: string | null = null) {
        const target = await policyTarget(db, orgId, kind, repoId);
        if (target === null) return [];
        return db.customRuleDraft.findMany({
          where: { orgId, kind, target, status: { in: ["PENDING", "COMPILED", "FAILED"] } },
          orderBy: { createdAt: "desc" },
          take: 20,
        });
      },

      async getDraft(draftId: string) {
        const id = parseId(draftId);
        return id === null ? null : db.customRuleDraft.findFirst({ where: { id, orgId } });
      },

      /** Proposes a plain-language rule for a layer; the worker then compiles it (P3.9). */
      async propose(kind: PolicyKind, repoId: string | null, text: string) {
        requireRole(ctx, kind === "ORG_GUARDRAIL" ? "OWNER" : "ADMIN");
        const ruleText = ruleTextSchema.parse(text);
        return db.$transaction(async (tx) => {
          const target = await policyTarget(tx, orgId, kind, repoId);
          if (target === null) throw new NotFoundError("repository not found");
          // The model server is shared by every tenant (D11): a few rules at a time per org.
          const waiting = await tx.customRuleDraft.count({ where: { orgId, status: "PENDING" } });
          if (waiting >= MAX_PENDING_DRAFTS) {
            throw new ConflictError("too many rules are still being compiled; try again shortly");
          }
          const draft = await tx.customRuleDraft.create({
            data: {
              orgId,
              kind,
              repoId: kind === "REPO" ? target : null,
              target,
              text: ruleText,
              createdById: actor.type === "USER" ? actor.userId : null,
            },
          });
          await writeAudit(tx, orgId, actor, {
            action: "custom_rule.proposed",
            target: auditTarget("rule_draft", draft.id),
            // Never the text: an admin may write anything there.
            metadata: { kind, repoId: draft.repoId, chars: ruleText.length },
          });
          return draft;
        });
      },

      /**
       * Turns a compiled or failed draft into one of the layer's custom rules, as a new policy
       * version: `code` (its compiled layer, confirmed by the admin) or `judge`.
       */
      async accept(draftId: string, enforcement: "code" | "judge") {
        const id = requireId(draftId, "rule draft");
        return db.$transaction(async (tx) => {
          const draft = await tx.customRuleDraft.findFirst({ where: { id, orgId } });
          if (draft === null) throw new NotFoundError("rule draft not found");
          requireRole(ctx, draft.kind === "ORG_GUARDRAIL" ? "OWNER" : "ADMIN");
          if (draft.status !== "COMPILED" && draft.status !== "FAILED") {
            throw new ConflictError("the rule is not ready, or already decided");
          }
          if (enforcement === "code" && draft.compiled === null) {
            throw new ConflictError("this rule has no compiled form: keep it as a judge rule");
          }
          const current = await tx.policyVersion.findFirst({
            where: { orgId, kind: draft.kind, target: draft.target },
            orderBy: { version: "desc" },
            select: { rules: true },
          });
          const layer = current === null ? {} : policyLayerSchema.parse(current.rules);
          const existing = layer.customRules ?? [];
          const next = Math.max(0, ...existing.map((rule) => Number(rule.id.slice(3)))) + 1;
          const rule =
            enforcement === "code"
              ? {
                  id: `CR-${String(next)}`,
                  text: draft.text,
                  enforcement,
                  compiled: draft.compiled,
                }
              : { id: `CR-${String(next)}`, text: draft.text, enforcement };
          const updated = policyLayerSchema.parse({ ...layer, customRules: [...existing, rule] });
          const saved = await appendPolicyVersion(tx, ctx, draft.kind, draft.target, updated);
          await tx.customRuleDraft.update({ where: { id }, data: { status: "ACCEPTED" } });
          await writeAudit(tx, orgId, actor, {
            action: "custom_rule.accepted",
            target: auditTarget("rule_draft", id),
            metadata: { ruleId: rule.id, enforcement, version: saved.version },
          });
          return saved;
        });
      },

      async discard(draftId: string) {
        const id = requireId(draftId, "rule draft");
        return db.$transaction(async (tx) => {
          const draft = await tx.customRuleDraft.findFirst({ where: { id, orgId } });
          if (draft === null) throw new NotFoundError("rule draft not found");
          requireRole(ctx, draft.kind === "ORG_GUARDRAIL" ? "OWNER" : "ADMIN");
          if (draft.status === "ACCEPTED" || draft.status === "DISCARDED") return draft;
          const updated = await tx.customRuleDraft.update({
            where: { id },
            data: { status: "DISCARDED" },
          });
          await writeAudit(tx, orgId, actor, {
            action: "custom_rule.discarded",
            target: auditTarget("rule_draft", id),
          });
          return updated;
        });
      },
    },

    failures: {
      /** The organization's failures, newest first, optionally of one repository or status. */
      list(page: FailurePage = {}) {
        const { take, before, repoId, status } = failurePageSchema.parse(page);
        return db.pipelineFailure.findMany({
          where: {
            orgId,
            ...(before === undefined ? {} : { id: { lt: before } }),
            ...(repoId === undefined ? {} : { repoId }),
            ...(status === undefined ? {} : { status }),
          },
          orderBy: { id: "desc" },
          take,
          select: {
            id: true,
            headSha: true,
            headBranch: true,
            status: true,
            category: true,
            confidence: true,
            summary: true,
            createdAt: true,
            repo: { select: { id: true, fullName: true } },
            _count: { select: { runs: true } },
          },
        });
      },

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
    attempts: {
      /**
       * Records a dispatched attempt on one of this org's failures (SPEC §2 step 7; the
       * dispatcher, P4.8, and the local-mode CLI, P4.6). Numbered per failure.
       */
      async create(input: AttemptInput) {
        const data = attemptInputSchema.parse(input);
        return db.$transaction(async (tx) => {
          const failure = await tx.pipelineFailure.findFirst({
            where: { id: data.failureId, orgId },
          });
          if (failure === null) throw new NotFoundError("failure not found");
          const previous = await tx.healAttempt.count({ where: { orgId, failureId: failure.id } });
          const attempt = await tx.healAttempt.create({
            data: {
              orgId,
              failureId: failure.id,
              attemptNo: previous + 1,
              targetSha: data.targetSha,
              failingCheck: data.failingCheck,
              dispatchRunId: data.dispatchRunId ?? null,
            },
          });
          await writeAudit(tx, orgId, actor, {
            action: "attempt.dispatched",
            target: auditTarget("attempt", attempt.id),
            metadata: {
              failureId: failure.id,
              attemptNo: attempt.attemptNo,
              failingCheck: attempt.failingCheck,
            },
          });
          return attempt;
        });
      },

      /**
       * Records the healer run GitHub created for an attempt's dispatch (`return_run_details`).
       * Until it is recorded no runner can open the attempt's session (SPEC §5.4, D16): the run ID
       * is what binds a runner's token to this attempt rather than another one in the same repo.
       * Recorded once, while the attempt is still waiting for its runner.
       */
      async recordDispatch(attemptId: string, runId: bigint) {
        const id = requireId(attemptId, "attempt");
        const run = githubIdSchema.parse(runId);
        return db.$transaction(async (tx) => {
          const attempt = await tx.healAttempt.findFirst({ where: { id, orgId } });
          if (attempt === null) throw new NotFoundError("attempt not found");
          if (attempt.dispatchRunId === run) return attempt;
          if (attempt.status !== "DISPATCHED" || attempt.dispatchRunId !== null) {
            throw new ConflictError("the attempt's dispatch run is already recorded");
          }
          const updated = await tx.healAttempt.update({
            where: { id },
            data: { dispatchRunId: run },
          });
          await writeAudit(tx, orgId, actor, {
            action: "attempt.dispatch_recorded",
            target: auditTarget("attempt", id),
            metadata: { runId: String(run) },
          });
          return updated;
        });
      },
    },
    customRules: {
      ...base.customRules,

      /**
       * Stores the model's proposal for a pending draft (P3.9): a compiled layer (re-validated, and
       * without custom rules of its own), a rule only a reviewer can check, or why it failed.
       */
      async recordCompiled(draftId: string, result: CompiledRuleRecord) {
        const id = requireId(draftId, "rule draft");
        const record = compiledRuleRecordSchema.parse(result);
        return db.$transaction(async (tx) => {
          const draft = await tx.customRuleDraft.findFirst({ where: { id, orgId } });
          if (draft === null) throw new NotFoundError("rule draft not found");
          if (draft.status !== "PENDING") return draft;
          const updated = await tx.customRuleDraft.update({
            where: { id },
            data:
              "error" in record
                ? { status: "FAILED", error: record.error }
                : {
                    status: "COMPILED",
                    compiled: record.compiled ?? Prisma.DbNull,
                    explanation: record.explanation,
                  },
          });
          await writeAudit(tx, orgId, actor, {
            action: "custom_rule.compiled",
            target: auditTarget("rule_draft", id),
            metadata:
              "error" in record
                ? { status: "FAILED" }
                : { status: "COMPILED", expressible: record.compiled !== null },
          });
          return updated;
        });
      },
    },
    repositories: {
      ...base.repositories,

      /**
       * Stores `.pipeheal.yml` as read at a commit (P3.7): its layer, or its errors, or neither
       * (no file). Audited with the commit and the error count only, never the file's content.
       */
      async recordPolicyFile(repositoryId: string, input: PolicyFileRecord) {
        const id = requireId(repositoryId, "repository");
        const record = policyFileRecordSchema.parse(input);
        return db.$transaction(async (tx) => {
          const repo = await tx.repository.findFirst({ where: { id, orgId } });
          if (repo === null) throw new NotFoundError("repository not found");
          const updated = await tx.repository.update({
            where: { id },
            data: {
              policyFile:
                record.layer === null ? Prisma.DbNull : (record.layer as Prisma.InputJsonObject),
              policyFileErrors: record.errors ?? Prisma.DbNull,
              policyFileCommitSha: record.commitSha,
              policyFileReadAt: new Date(),
            },
          });
          await writeAudit(tx, orgId, actor, {
            action: "repository.policy_file",
            target: auditTarget("repository", id),
            metadata: {
              commitSha: record.commitSha,
              status:
                record.layer !== null ? "loaded" : record.errors !== null ? "invalid" : "absent",
              errors: record.errors?.length ?? 0,
            },
          });
          return updated;
        });
      },

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
            // rerunByUs: our flaky check's re-run passed (SPEC §6.2 step 8).
            metadata: { runId: String(runId), runAttempt, rerunByUs: run.rerunByUs },
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
        const { errorWindow, signals, classification, redactions } =
          jobTriageInputSchema.parse(input);
        return db.$transaction(async (tx) => {
          const job = await tx.failedJob.findFirst({
            where: { id, orgId },
            include: { failedRun: { select: { failureId: true } } },
          });
          if (job === null) throw new NotFoundError("failed job not found");
          const updated = await tx.failedJob.update({
            where: { id },
            data: {
              errorWindow,
              ...(signals === undefined ? {} : { signals }),
              ...(classification === undefined
                ? {}
                : {
                    category: toCategory(classification.category),
                    confidence: classification.confidence,
                    summary: classification.summary,
                  }),
            },
          });
          await writeAudit(tx, orgId, actor, {
            action: "failure.job_triaged",
            target: auditTarget("failure", job.failedRun.failureId),
            metadata: {
              failedJobId: id,
              githubJobId: String(job.githubJobId),
              ...(classification === undefined
                ? {}
                : { category: classification.category, confidence: classification.confidence }),
              ...(redactions === undefined ? {} : { redactions }),
            },
          });
          return updated;
        });
      },

      /** How many model calls this failure has cost so far (a per-failure cap, SPEC §13). */
      async modelCallCount(failureId: string) {
        const id = parseId(failureId);
        if (id === null) return 0;
        return db.modelCall.count({ where: { orgId, failureId: id } });
      },

      /** Records one model call made for this failure, with its tokens and cost (SPEC §13). */
      async recordModelCall(failureId: string, input: ModelCallInput) {
        const id = requireId(failureId, "failure");
        const call = modelCallInputSchema.parse(input);
        return db.$transaction(async (tx) => {
          const failure = await tx.pipelineFailure.findFirst({ where: { id, orgId } });
          if (failure === null) throw new NotFoundError("failure not found");
          const created = await tx.modelCall.create({
            data: { orgId, failureId: id, ...call, costUsd: call.costUsd.toFixed(6) },
          });
          await writeAudit(tx, orgId, actor, {
            action: "failure.model_called",
            target: auditTarget("failure", id),
            metadata: {
              purpose: call.purpose,
              model: call.model,
              outcome: call.outcome,
              inputTokens: call.inputTokens,
              outputTokens: call.outputTokens,
              costUsd: call.costUsd.toFixed(6),
            },
          });
          return created;
        });
      },

      /**
       * The failure's category, from its jobs' (SPEC §6.2). A DETECTED failure becomes TRIAGED;
       * any other status (FLAKY, or later stages) stays as it is.
       */
      async recordTriage(failureId: string, input: ClassificationInput) {
        const id = requireId(failureId, "failure");
        const { category, confidence, summary } = classificationSchema.parse(input);
        return db.$transaction(async (tx) => {
          const failure = await tx.pipelineFailure.findFirst({ where: { id, orgId } });
          if (failure === null) throw new NotFoundError("failure not found");
          const updated = await tx.pipelineFailure.update({
            where: { id },
            data: {
              category: toCategory(category),
              confidence,
              summary,
              ...(failure.status === "DETECTED" ? { status: "TRIAGED" as const } : {}),
            },
          });
          await writeAudit(tx, orgId, actor, {
            action: "failure.triaged",
            target: auditTarget("failure", id),
            metadata: { category, confidence, status: updated.status },
          });
          return updated;
        });
      },

      /**
       * Claims a failed run for the flaky check's re-run (SPEC §6.2 step 8): at most once per run,
       * atomically, before GitHub is asked, so a retried job can never re-run it twice. Returns
       * the run when claimed; null when it was claimed before or isn't failing.
       */
      async claimRerun(failedRunId: string) {
        const id = requireId(failedRunId, "failed run");
        return db.$transaction(async (tx) => {
          const run = await tx.failedRun.findFirst({ where: { id, orgId } });
          if (run === null) throw new NotFoundError("failed run not found");
          const { count } = await tx.failedRun.updateMany({
            where: { id, orgId, rerunByUs: false, conclusion: { in: ["failure", "timed_out"] } },
            data: { rerunByUs: true, rerunFromAttempt: run.runAttempt },
          });
          if (count === 0) return null;
          await writeAudit(tx, orgId, actor, {
            action: "failure.rerun_requested",
            target: auditTarget("failure", run.failureId),
            metadata: { runId: String(run.runId), runAttempt: run.runAttempt },
          });
          return { ...run, rerunByUs: true, rerunFromAttempt: run.runAttempt };
        });
      },

      /**
       * Stores what changed since the failure's last green commit (SPEC §6.2 step 7), or that
       * there was nothing to compare with. Replaces an earlier record.
       */
      async recordRecentChanges(failureId: string, input: RecentChangesRecord) {
        const id = requireId(failureId, "failure");
        const record = recentChangesRecordSchema.parse(input);
        return db.$transaction(async (tx) => {
          const failure = await tx.pipelineFailure.findFirst({ where: { id, orgId } });
          if (failure === null) throw new NotFoundError("failure not found");
          const updated = await tx.pipelineFailure.update({
            where: { id },
            data: { recentChanges: record },
          });
          await writeAudit(tx, orgId, actor, {
            action: "failure.recent_changes",
            target: auditTarget("failure", id),
            // Counts and the base only: never diffs or commit messages.
            metadata:
              record.base === null
                ? { base: null, reason: record.reason }
                : {
                    baseSha: record.base.sha,
                    source: record.base.source,
                    commits: record.changes.totalCommits,
                    files: record.changes.totalFiles,
                    filesShown: record.changes.files.length,
                    estimatedTokens: record.changes.estimatedTokens,
                    redactions: record.changes.redactions,
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
