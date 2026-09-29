// Needs Postgres: `docker compose up -d` (runs against the `pipeheal_test` database).
// Tenant isolation (P1.2): a user or worker scoped to org A can neither read nor change org B's
// rows through any helper. Every helper must have a case in `crossOrgCases`; a meta-test fails
// when one is added without it.
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors";
import type {
  Organization,
  PipelineFailure,
  RepoWorkflow,
  Repository,
  User,
} from "./generated/prisma/client";
import type { Role } from "./generated/prisma/enums";
import type { FailedRunInput } from "./inputs";
import { installations } from "./installations";
import {
  SYNC_BATCH_LIMIT,
  forMember,
  forSystem,
  organizationsOf,
  type OrgScope,
  type SystemScope,
} from "./scope";
import { createTestDb } from "./testing";

const db = createTestDb();
const installs = installations(db, "test");

afterAll(async () => {
  await db.$disconnect();
});

function githubId(): bigint {
  return BigInt(randomInt(1, 2 ** 47));
}

function sha(): string {
  return randomUUID().replaceAll("-", "").padEnd(40, "0");
}

/** A failed run of the repo's CI workflow, as the worker would pass it. */
function failedRun(overrides: Partial<FailedRunInput> = {}): FailedRunInput {
  const runId = githubId();
  return {
    headSha: sha(),
    headBranch: "main",
    runId,
    runAttempt: 1,
    workflowId: 11n,
    workflowName: "CI",
    workflowPath: ".github/workflows/ci.yml",
    conclusion: "failure",
    htmlUrl: `https://github.com/acme/app/actions/runs/${String(runId)}`,
    jobs: [{ githubJobId: githubId(), name: "check", failedStep: "Test", htmlUrl: null }],
    ...overrides,
  };
}

function modelCall() {
  return {
    purpose: "triage",
    model: "claude-haiku-4-5-20251001",
    promptVersion: "triage-v1",
    inputTokens: 1200,
    outputTokens: 80,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.0016,
    outcome: "valid" as const,
  };
}

function uniqueLogin(): string {
  return `T${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

async function createUser(): Promise<User> {
  const id = randomUUID();
  return db.user.create({ data: { id, name: "Test User", email: `${id}@example.test` } });
}

async function addMember(org: Organization, role: Role): Promise<User> {
  const user = await createUser();
  // Membership creation gets its own helper with the OWNER binding (P1.3).
  await db.membership.create({ data: { orgId: org.id, userId: user.id, role } });
  return user;
}

interface Tenant {
  org: Organization;
  /** GitHub ID of the user who installed the App (the OWNER candidate). */
  installerGithubId: bigint;
  repo: Repository;
  workflow: RepoWorkflow;
  /** An open failure of `repo`, with one failed run and job. */
  failure: PipelineFailure;
  failureRun: FailedRunInput;
  /** The failure's one failed job. */
  failedJobId: string;
  admin: User;
  member: User;
  system: SystemScope;
  asAdmin: OrgScope;
  asMember: OrgScope;
}

/** What GitHub confirms for an org admin who can access `tenant`'s installation. */
function adminOf(...tenants: Tenant[]) {
  return {
    installationIds: tenants.map((tenant) => tenant.org.installationId),
    adminOrgIds: tenants.map((tenant) => tenant.org.githubAccountId),
  };
}

function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`test setup: no ${what}`);
  return value;
}

async function createTenant(): Promise<Tenant> {
  const login = uniqueLogin();
  const installerGithubId = githubId();
  const org = await installs.upsert({
    githubAccountId: githubId(),
    login,
    accountType: "ORG",
    installationId: githubId(),
    installerGithubId,
  });
  const [admin, member] = await Promise.all([addMember(org, "ADMIN"), addMember(org, "MEMBER")]);
  const system = await forSystem(db, org.id, "test");
  const [repo] = await system.repositories.syncInstalled([
    { githubRepoId: githubId(), fullName: `${login}/app`, defaultBranch: "main" },
  ]);
  // A known workflow row, created directly: setup, not the helper under test.
  const workflow = await db.repoWorkflow.create({
    data: {
      orgId: org.id,
      repoId: present(repo, "repository").id,
      githubWorkflowId: githubId(),
      path: ".github/workflows/ci.yml",
      name: "CI",
      triggers: ["push"],
    },
  });
  const failureRun = failedRun();
  const { failure, run } = await system.failures.recordFailedRun(
    present(repo, "repository").id,
    failureRun,
  );
  const failedJob = await db.failedJob.findFirstOrThrow({ where: { failedRunId: run.id } });
  return {
    org,
    installerGithubId,
    repo: present(repo, "repository"),
    workflow,
    failure,
    failureRun,
    failedJobId: failedJob.id,
    admin,
    member,
    system,
    asAdmin: present(await forMember(db, { orgSlug: org.slug, userId: admin.id }), "admin scope"),
    asMember: present(
      await forMember(db, { orgSlug: org.slug, userId: member.id }),
      "member scope",
    ),
  };
}

/** Everything org B owns, to prove an attempt from org A changed nothing. */
async function snapshot(tenant: Tenant) {
  const where = { orgId: tenant.org.id };
  return {
    org: await db.organization.findUnique({ where: { id: tenant.org.id } }),
    repositories: await db.repository.findMany({ where, orderBy: { id: "asc" } }),
    workflows: await db.repoWorkflow.findMany({ where, orderBy: { id: "asc" } }),
    memberships: await db.membership.findMany({ where, orderBy: { id: "asc" } }),
    failures: await db.pipelineFailure.findMany({ where, orderBy: { id: "asc" } }),
    failedRuns: await db.failedRun.findMany({ where, orderBy: { id: "asc" } }),
    failedJobs: await db.failedJob.findMany({ where, orderBy: { id: "asc" } }),
    auditLogs: await db.auditLog.findMany({ where, orderBy: { id: "asc" } }),
  };
}

async function auditCount(tenant: Tenant): Promise<number> {
  return db.auditLog.count({ where: { orgId: tenant.org.id } });
}

let a: Tenant;
let b: Tenant;

beforeEach(async () => {
  [a, b] = await Promise.all([createTenant(), createTenant()]);
});

// One case per helper: A's scope pointed at B's rows. Each case asserts what A gets back; the
// shared test below asserts that B's rows, memberships and audit log are unchanged.
const crossOrgCases: Record<string, () => Promise<void>> = {
  "repositories.list": async () => {
    const repos = await a.asAdmin.repositories.list();
    expect(repos.map((repo) => repo.id)).toEqual([a.repo.id]);
  },
  "repositories.get": async () => {
    await expect(a.asAdmin.repositories.get(b.repo.id)).resolves.toBeNull();
  },
  "repositories.setEnabled": async () => {
    await expect(a.asAdmin.repositories.setEnabled(b.repo.id, true)).rejects.toThrow(NotFoundError);
    await expect(a.system.repositories.setEnabled(b.repo.id, true)).rejects.toThrow(NotFoundError);
  },
  "repositories.findByGithubId": async () => {
    await expect(a.system.repositories.findByGithubId(b.repo.githubRepoId)).resolves.toBeNull();
  },
  "repositories.syncInstalled": async () => {
    // Same GitHub repo reported for A (e.g. a transfer): A gets its own row, B's is untouched.
    const [copy] = await a.system.repositories.syncInstalled([
      { githubRepoId: b.repo.githubRepoId, fullName: "attacker/renamed", defaultBranch: "evil" },
    ]);
    expect(copy).toMatchObject({ orgId: a.org.id, fullName: "attacker/renamed" });
    expect(copy?.id).not.toBe(b.repo.id);
  },
  "repositories.markRemoved": async () => {
    await expect(a.system.repositories.markRemoved([b.repo.githubRepoId])).resolves.toBe(0);
  },
  "workflows.listForRepo": async () => {
    await expect(a.asAdmin.workflows.listForRepo(b.repo.id)).resolves.toEqual([]);
  },
  "workflows.setSelected": async () => {
    const selected = !b.workflow.selected;
    await expect(a.asAdmin.workflows.setSelected(b.workflow.id, selected)).rejects.toThrow(
      NotFoundError,
    );
    await expect(a.system.workflows.setSelected(b.workflow.id, selected)).rejects.toThrow(
      NotFoundError,
    );
  },
  "workflows.syncInstalled": async () => {
    await expect(
      a.system.workflows.syncInstalled(b.repo.id, [
        { githubWorkflowId: githubId(), path: ".github/workflows/x.yml", name: "X" },
      ]),
    ).rejects.toThrow(NotFoundError);
  },
  "failures.get": async () => {
    await expect(a.asAdmin.failures.get(b.failure.id)).resolves.toBeNull();
    await expect(a.system.failures.get(b.failure.id)).resolves.toBeNull();
  },
  "failures.findBySha": async () => {
    await expect(a.system.failures.findBySha(b.repo.id, b.failure.headSha)).resolves.toBeNull();
  },
  "failures.recordFailedRun": async () => {
    await expect(
      a.system.failures.recordFailedRun(b.repo.id, failedRun({ headSha: b.failure.headSha })),
    ).rejects.toThrow(NotFoundError);
  },
  "failures.recordPassedRun": async () => {
    await expect(
      a.system.failures.recordPassedRun(b.repo.id, { runId: b.failureRun.runId, runAttempt: 2 }),
    ).rejects.toThrow(NotFoundError);
  },
  "failures.closeWindow": async () => {
    await expect(a.system.failures.closeWindow(b.failure.id)).rejects.toThrow(NotFoundError);
  },
  "failures.recordJobTriage": async () => {
    await expect(
      a.system.failures.recordJobTriage(b.failedJobId, { errorWindow: "planted" }),
    ).rejects.toThrow(NotFoundError);
  },
  "failures.recordModelCall": async () => {
    await expect(a.system.failures.recordModelCall(b.failure.id, modelCall())).rejects.toThrow(
      NotFoundError,
    );
  },
  "failures.recordTriage": async () => {
    await expect(
      a.system.failures.recordTriage(b.failure.id, {
        category: "config",
        confidence: 1,
        summary: "planted",
      }),
    ).rejects.toThrow(NotFoundError);
  },
  "members.list": async () => {
    const members = await a.asAdmin.members.list();
    expect(members.map((m) => m.user.id).sort()).toEqual([a.admin.id, a.member.id].sort());
  },
  "audit.list": async () => {
    const entries = await a.asAdmin.audit.list({ take: 200 });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.orgId === a.org.id)).toBe(true);
  },
  // Installation helpers are keyed by GitHub IDs from signed webhooks, not by an org scope: they
  // must only ever touch the organization those IDs name.
  "installations.findByInstallationId": async () => {
    const found = await installs.findByInstallationId(a.org.installationId);
    expect(found?.id).toBe(a.org.id);
  },
  "installations.upsert": async () => {
    await installs.upsert({
      githubAccountId: a.org.githubAccountId,
      login: uniqueLogin(),
      accountType: "USER",
      installationId: githubId(),
    });
  },
  "installations.setStatus": async () => {
    await installs.setStatus(a.org.installationId, "SUSPENDED");
  },
  "installations.ownerCandidates": async () => {
    const user = await createUser();
    const candidates = await installs.ownerCandidates({
      userId: user.id,
      githubUserId: a.installerGithubId,
    });
    expect(candidates.map((org) => org.id)).toEqual([a.org.id]);
  },
  // A's installer, even as an admin who can access B's installation on GitHub, must not become
  // B's owner: only B's installer can.
  "installations.bindVerifiedOwner": async () => {
    const user = await createUser();
    const claim = { userId: user.id, githubUserId: a.installerGithubId };
    await expect(installs.bindVerifiedOwner(claim, adminOf(b))).resolves.toEqual([]);
  },
};

function helperNames(scope: object, prefix = ""): string[] {
  return Object.entries(scope).flatMap(([key, value]) => {
    if (typeof value === "function") return [`${prefix}${key}`];
    if (typeof value === "object" && value !== null && !["org", "role"].includes(key)) {
      return helperNames(value as object, `${prefix}${key}.`);
    }
    return [];
  });
}

function allHelperNames(): string[] {
  return [
    ...helperNames(a.system),
    ...helperNames(installs).map((name) => `installations.${name}`),
  ];
}

// P1.8: every helper that changes data records who did it, what changed, in which org and when.
// Each mutating helper has a case here (a real change to tenant A, returning the entries it must
// write, oldest first); every other helper is listed as read-only. A meta-test fails when a
// helper is added to neither list.
const readOnlyHelpers = [
  "repositories.list",
  "repositories.get",
  "repositories.findByGithubId",
  "workflows.listForRepo",
  "failures.get",
  "failures.findBySha",
  "members.list",
  "audit.list",
  "installations.findByInstallationId",
  "installations.ownerCandidates",
];

const auditCases: Record<string, () => Promise<Record<string, unknown>[]>> = {
  "repositories.setEnabled": async () => {
    await a.asAdmin.repositories.setEnabled(a.repo.id, true);
    return [
      {
        actorType: "USER",
        actorId: a.admin.id,
        action: "repository.enabled",
        target: `repository:${a.repo.id}`,
      },
    ];
  },
  "repositories.syncInstalled": async () => {
    const fullName = `${a.org.login}/renamed`;
    await a.system.repositories.syncInstalled([
      { githubRepoId: a.repo.githubRepoId, fullName, defaultBranch: "main" },
    ]);
    return [
      {
        actorType: "SYSTEM",
        actorId: "test",
        action: "repository.updated",
        target: `repository:${a.repo.id}`,
        metadata: { fullName, changes: { fullName: { from: a.repo.fullName, to: fullName } } },
      },
    ];
  },
  "repositories.markRemoved": async () => {
    await a.system.repositories.markRemoved([a.repo.githubRepoId]);
    return [
      {
        actorType: "SYSTEM",
        actorId: "test",
        action: "repository.removed",
        target: `repository:${a.repo.id}`,
      },
    ];
  },
  "workflows.setSelected": async () => {
    await a.asAdmin.workflows.setSelected(a.workflow.id, true);
    return [
      {
        actorType: "USER",
        actorId: a.admin.id,
        action: "workflow.selected",
        target: `workflow:${a.workflow.id}`,
        metadata: { repoId: a.repo.id },
      },
    ];
  },
  "workflows.syncInstalled": async () => {
    await a.system.workflows.syncInstalled(a.repo.id, [
      { githubWorkflowId: a.workflow.githubWorkflowId, path: a.workflow.path, name: "Checks" },
    ]);
    return [
      {
        actorType: "SYSTEM",
        actorId: "test",
        action: "workflow.updated",
        target: `workflow:${a.workflow.id}`,
        metadata: { repoId: a.repo.id, changes: { name: { from: "CI", to: "Checks" } } },
      },
    ];
  },
  "failures.recordFailedRun": async () => {
    const run = failedRun({
      headSha: a.failure.headSha,
      workflowPath: ".github/workflows/lint.yml",
    });
    await a.system.failures.recordFailedRun(a.repo.id, run);
    return [
      {
        actorType: "SYSTEM",
        actorId: "test",
        action: "failure.run_attached",
        target: `failure:${a.failure.id}`,
        metadata: {
          runId: String(run.runId),
          runAttempt: 1,
          workflowPath: ".github/workflows/lint.yml",
          headSha: a.failure.headSha,
          lateArrival: false,
        },
      },
    ];
  },
  "failures.recordPassedRun": async () => {
    await a.system.failures.recordPassedRun(a.repo.id, {
      runId: a.failureRun.runId,
      runAttempt: 2,
    });
    return [
      {
        actorType: "SYSTEM",
        action: "failure.run_passed",
        target: `failure:${a.failure.id}`,
        metadata: { runId: String(a.failureRun.runId), runAttempt: 2 },
      },
      {
        actorType: "SYSTEM",
        action: "failure.flaky",
        target: `failure:${a.failure.id}`,
        metadata: { from: "DETECTED", to: "FLAKY" },
      },
    ];
  },
  "failures.recordJobTriage": async () => {
    await a.system.failures.recordJobTriage(a.failedJobId, {
      errorWindow: "error TS2305",
      redactions: { "github-token": 2 },
    });
    return [
      {
        actorType: "SYSTEM",
        actorId: "test",
        action: "failure.job_triaged",
        target: `failure:${a.failure.id}`,
        metadata: { failedJobId: a.failedJobId, redactions: { "github-token": 2 } },
      },
    ];
  },
  "failures.recordModelCall": async () => {
    await a.system.failures.recordModelCall(a.failure.id, modelCall());
    return [
      {
        actorType: "SYSTEM",
        actorId: "test",
        action: "failure.model_called",
        target: `failure:${a.failure.id}`,
        metadata: {
          purpose: "triage",
          model: "claude-haiku-4-5-20251001",
          outcome: "valid",
          inputTokens: 1200,
          outputTokens: 80,
          costUsd: "0.001600",
        },
      },
    ];
  },
  "failures.recordTriage": async () => {
    await a.system.failures.recordTriage(a.failure.id, {
      category: "typecheck",
      confidence: 0.95,
      summary: "tsc: TS2305",
    });
    return [
      {
        actorType: "SYSTEM",
        action: "failure.triaged",
        target: `failure:${a.failure.id}`,
        metadata: { category: "typecheck", confidence: 0.95, status: "TRIAGED" },
      },
    ];
  },
  "failures.closeWindow": async () => {
    await a.system.failures.closeWindow(a.failure.id);
    return [
      {
        actorType: "SYSTEM",
        actorId: "test",
        action: "failure.window_closed",
        target: `failure:${a.failure.id}`,
        metadata: { early: true },
      },
    ];
  },
  "installations.upsert": async () => {
    const login = uniqueLogin();
    await installs.upsert({
      githubAccountId: a.org.githubAccountId,
      login,
      accountType: "ORG",
      installationId: a.org.installationId,
    });
    return [
      {
        actorType: "SYSTEM",
        actorId: "test",
        action: "organization.updated",
        target: `organization:${a.org.id}`,
        metadata: { changes: { login: { from: a.org.login, to: login } } },
      },
    ];
  },
  "installations.setStatus": async () => {
    await installs.setStatus(a.org.installationId, "SUSPENDED");
    return [
      {
        actorType: "SYSTEM",
        actorId: "test",
        action: "organization.suspended",
        target: `organization:${a.org.id}`,
        metadata: { from: "ACTIVE", to: "SUSPENDED" },
      },
    ];
  },
  "installations.bindVerifiedOwner": async () => {
    const user = await createUser();
    await installs.bindVerifiedOwner(
      { userId: user.id, githubUserId: a.installerGithubId },
      adminOf(a),
    );
    return [
      {
        actorType: "SYSTEM",
        actorId: "test",
        action: "member.owner_verified",
        target: `user:${user.id}`,
      },
    ];
  },
};

async function auditIds(tenant: Tenant): Promise<Set<string>> {
  const entries = await db.auditLog.findMany({
    where: { orgId: tenant.org.id },
    select: { id: true },
  });
  return new Set(entries.map((entry) => entry.id));
}

describe("audit coverage (P1.8)", () => {
  it("classifies every helper as either mutating (with an audit case) or read-only", () => {
    expect([...Object.keys(auditCases), ...readOnlyHelpers].sort()).toEqual(
      allHelperNames().sort(),
    );
  });

  it.each(Object.keys(auditCases))("%s records who, what, where and when", async (name) => {
    const before = await auditIds(a);
    const startedAt = Date.now();

    const expected = await present(auditCases[name], "case")();

    const written = (
      await db.auditLog.findMany({ where: { orgId: a.org.id }, orderBy: { id: "asc" } })
    ).filter((entry) => !before.has(entry.id));
    expect(written).toMatchObject(expected);
    for (const entry of written) {
      // The database's clock stamps `createdAt`: allow for skew against this process's clock.
      expect(Math.abs(entry.createdAt.getTime() - startedAt)).toBeLessThan(60_000);
    }
  });
});

describe("tenant isolation", () => {
  it("has a cross-org case for every helper", () => {
    const helpers = allHelperNames();
    // The member scope is a subset of the system scope.
    expect(helperNames(a.asAdmin).every((name) => helpers.includes(name))).toBe(true);
    expect(Object.keys(crossOrgCases).sort()).toEqual(helpers.sort());
  });

  it.each(Object.keys(crossOrgCases))("%s cannot read or change another org", async (name) => {
    const before = await snapshot(b);
    await present(crossOrgCases[name], "case")();
    expect(await snapshot(b)).toEqual(before);
  });

  it("gives no scope to a user in an organization they don't belong to", async () => {
    await expect(forMember(db, { orgSlug: b.org.slug, userId: a.admin.id })).resolves.toBeNull();
    await expect(forMember(db, { orgSlug: uniqueLogin(), userId: a.admin.id })).resolves.toBeNull();
  });

  it("finds the membership whatever the slug's case (GitHub logins are case-insensitive)", async () => {
    const scope = await forMember(db, { orgSlug: a.org.login.toUpperCase(), userId: a.admin.id });
    expect(scope?.org.id).toBe(a.org.id);
  });

  it("treats malformed IDs like unknown ones", async () => {
    await expect(a.asAdmin.repositories.get("not-a-uuid")).resolves.toBeNull();
    await expect(a.asAdmin.workflows.listForRepo("'; DROP TABLE x; --")).resolves.toEqual([]);
    await expect(a.asAdmin.repositories.setEnabled("nope", true)).rejects.toThrow(NotFoundError);
    await expect(a.asAdmin.workflows.setSelected("nope", true)).rejects.toThrow(NotFoundError);
    await expect(forSystem(db, "nope", "test")).rejects.toThrow(NotFoundError);
    await expect(forSystem(db, randomUUID(), "test")).rejects.toThrow(NotFoundError);
    await expect(a.system.repositories.findByGithubId(-5n)).resolves.toBeNull();
    await expect(installs.findByInstallationId(0n)).resolves.toBeNull();
  });
});

describe("OWNER binding (SPEC §5.2)", () => {
  it("binds the installer as OWNER once GitHub confirms their access, exactly once", async () => {
    const user = await createUser();
    const claim = { userId: user.id, githubUserId: a.installerGithubId };

    const bound = await installs.bindVerifiedOwner(claim, {
      installationIds: [a.org.installationId, githubId()],
      adminOrgIds: [a.org.githubAccountId, githubId()],
    });
    const again = await installs.bindVerifiedOwner(claim, adminOf(a));

    expect(bound).toEqual([a.org.id]);
    expect(again).toEqual([]);
    await expect(installs.ownerCandidates(claim)).resolves.toEqual([]);
    const scope = await forMember(db, { orgSlug: a.org.slug, userId: user.id });
    expect(scope?.role).toBe("OWNER");
    const [latest] = await a.asAdmin.audit.list({ take: 1 });
    expect(latest).toMatchObject({
      actorType: "SYSTEM",
      actorId: "test",
      action: "member.owner_verified",
      target: `user:${user.id}`,
      metadata: { githubUserId: String(a.installerGithubId) },
    });
  });

  it("uses up the candidate: a removed owner isn't bound again at their next sign-in", async () => {
    const user = await createUser();
    const claim = { userId: user.id, githubUserId: a.installerGithubId };
    await installs.bindVerifiedOwner(claim, adminOf(a));

    await expect(db.organization.findUnique({ where: { id: a.org.id } })).resolves.toMatchObject({
      installerGithubId: null,
    });
    await db.membership.deleteMany({ where: { orgId: a.org.id, userId: user.id } });
    await expect(installs.ownerCandidates(claim)).resolves.toEqual([]);
    await expect(installs.bindVerifiedOwner(claim, adminOf(a))).resolves.toEqual([]);
  });

  it("binds one owner when two sign-ins race", async () => {
    const user = await createUser();
    const claim = { userId: user.id, githubUserId: a.installerGithubId };

    const results = await Promise.allSettled([
      installs.bindVerifiedOwner(claim, adminOf(a)),
      installs.bindVerifiedOwner(claim, adminOf(a)),
    ]);

    const bound = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    expect(bound).toEqual([a.org.id]);
    await expect(
      db.membership.count({ where: { orgId: a.org.id, userId: user.id, role: "OWNER" } }),
    ).resolves.toBe(1);
    await expect(
      db.auditLog.count({ where: { orgId: a.org.id, action: "member.owner_verified" } }),
    ).resolves.toBe(1);
  });

  it("binds nothing when GitHub doesn't list the installation, or the org isn't active", async () => {
    const user = await createUser();
    const claim = { userId: user.id, githubUserId: a.installerGithubId };

    await expect(
      installs.bindVerifiedOwner(claim, {
        installationIds: [],
        adminOrgIds: [a.org.githubAccountId],
      }),
    ).resolves.toEqual([]);
    await installs.setStatus(a.org.installationId, "SUSPENDED");
    await expect(installs.ownerCandidates(claim)).resolves.toEqual([]);
    await expect(installs.bindVerifiedOwner(claim, adminOf(a))).resolves.toEqual([]);
    await expect(forMember(db, { orgSlug: a.org.slug, userId: user.id })).resolves.toBeNull();
  });

  // D10: a repository admin can install the App on an org's repos without being an org owner.
  it("doesn't bind an installer who isn't an admin of the organization", async () => {
    const user = await createUser();
    const claim = { userId: user.id, githubUserId: a.installerGithubId };

    await expect(
      installs.bindVerifiedOwner(claim, {
        installationIds: [a.org.installationId],
        adminOrgIds: [b.org.githubAccountId],
      }),
    ).resolves.toEqual([]);
    await expect(forMember(db, { orgSlug: a.org.slug, userId: user.id })).resolves.toBeNull();
  });

  it("binds a personal account only to the account's own user", async () => {
    const owner = githubId();
    const personal = await installs.upsert({
      githubAccountId: owner,
      login: uniqueLogin(),
      accountType: "USER",
      installationId: githubId(),
      installerGithubId: owner,
    });
    const evidence = { installationIds: [personal.installationId], adminOrgIds: [] };
    const someoneElse = await createUser();
    const accountUser = await createUser();

    // Someone else can't be the installer of a personal account; if a record ever said so, no.
    await db.organization.update({ where: { id: personal.id }, data: { installerGithubId: 77n } });
    await expect(
      installs.bindVerifiedOwner({ userId: someoneElse.id, githubUserId: 77n }, evidence),
    ).resolves.toEqual([]);
    await db.organization.update({
      where: { id: personal.id },
      data: { installerGithubId: owner },
    });
    await expect(
      installs.bindVerifiedOwner({ userId: accountUser.id, githubUserId: owner }, evidence),
    ).resolves.toEqual([personal.id]);
  });

  it("lists a user's organizations and nobody else's", async () => {
    const user = await createUser();
    await db.membership.create({ data: { orgId: b.org.id, userId: user.id, role: "MEMBER" } });
    await installs.bindVerifiedOwner(
      { userId: user.id, githubUserId: a.installerGithubId },
      adminOf(a),
    );

    const orgs = await organizationsOf(db, user.id);

    expect(orgs.map(({ org, role }) => [org.id, role]).sort()).toEqual(
      [
        [a.org.id, "OWNER"],
        [b.org.id, "MEMBER"],
      ].sort(),
    );
    await expect(organizationsOf(db, (await createUser()).id)).resolves.toEqual([]);
  });
});

describe("roles", () => {
  it("lets members read but not change repositories or workflows", async () => {
    const before = await snapshot(a);

    await expect(a.asMember.repositories.list()).resolves.toHaveLength(1);
    await expect(a.asMember.workflows.listForRepo(a.repo.id)).resolves.toHaveLength(1);
    await expect(a.asMember.repositories.setEnabled(a.repo.id, true)).rejects.toThrow(
      ForbiddenError,
    );
    await expect(a.asMember.workflows.setSelected(a.workflow.id, true)).rejects.toThrow(
      ForbiddenError,
    );
    expect(await snapshot(a)).toEqual(before);
  });

  it("exposes the member's role and org, and no member emails", async () => {
    expect(a.asMember.role).toBe("MEMBER");
    expect(a.asAdmin.org).toEqual({
      id: a.org.id,
      slug: a.org.slug,
      login: a.org.login,
      accountType: "ORG",
      status: "ACTIVE",
    });
    const [first] = await a.asAdmin.members.list();
    expect(Object.keys(present(first, "member").user).sort()).toEqual([
      "id",
      "image",
      "login",
      "name",
    ]);
  });
});

describe("audit", () => {
  async function latestAudit(tenant: Tenant) {
    return db.auditLog.findFirst({ where: { orgId: tenant.org.id }, orderBy: { id: "desc" } });
  }

  it("records a user's change with the user as actor, in the org it happened in", async () => {
    const count = await auditCount(a);
    await a.asAdmin.repositories.setEnabled(a.repo.id, true);

    expect(await auditCount(a)).toBe(count + 1);
    expect(await latestAudit(a)).toMatchObject({
      actorType: "USER",
      actorId: a.admin.id,
      action: "repository.enabled",
      target: `repository:${a.repo.id}`,
    });

    await a.asAdmin.workflows.setSelected(a.workflow.id, true);
    expect(await latestAudit(a)).toMatchObject({
      action: "workflow.selected",
      target: `workflow:${a.workflow.id}`,
      metadata: { repoId: a.repo.id },
    });
    await a.asAdmin.repositories.setEnabled(a.repo.id, false);
    expect(await latestAudit(a)).toMatchObject({ action: "repository.disabled" });
    await a.asAdmin.workflows.setSelected(a.workflow.id, false);
    expect(await latestAudit(a)).toMatchObject({ action: "workflow.deselected" });
  });

  it("writes nothing for a no-op or a refused change", async () => {
    const count = await auditCount(a);

    await a.asAdmin.repositories.setEnabled(a.repo.id, false);
    await a.asAdmin.workflows.setSelected(a.workflow.id, false);
    await expect(a.asMember.repositories.setEnabled(a.repo.id, true)).rejects.toThrow(
      ForbiddenError,
    );
    await a.system.repositories.syncInstalled([
      { githubRepoId: a.repo.githubRepoId, fullName: a.repo.fullName, defaultBranch: "main" },
    ]);
    await expect(a.system.repositories.markRemoved([githubId()])).resolves.toBe(0);

    expect(await auditCount(a)).toBe(count);
  });

  it("records installation syncs as the system component", async () => {
    const [renamed] = await a.system.repositories.syncInstalled([
      {
        githubRepoId: a.repo.githubRepoId,
        fullName: `${a.org.login}/renamed`,
        defaultBranch: "dev",
      },
    ]);
    expect(renamed).toMatchObject({ id: a.repo.id, defaultBranch: "dev" });
    expect(await latestAudit(a)).toMatchObject({
      actorType: "SYSTEM",
      actorId: "test",
      action: "repository.updated",
      metadata: { fullName: `${a.org.login}/renamed` },
    });

    await a.asAdmin.repositories.setEnabled(a.repo.id, true);
    await expect(a.system.repositories.markRemoved([a.repo.githubRepoId])).resolves.toBe(1);
    expect(await latestAudit(a)).toMatchObject({ action: "repository.removed" });
    const removed = await a.asAdmin.repositories.get(a.repo.id);
    expect(removed?.enabled).toBe(false);
    expect(removed?.removedFromInstallationAt).toBeInstanceOf(Date);
    await expect(a.asAdmin.repositories.list()).resolves.toEqual([]);
    await expect(a.asAdmin.repositories.setEnabled(a.repo.id, true)).rejects.toThrow(ConflictError);

    const [readded] = await a.system.repositories.syncInstalled([
      {
        githubRepoId: a.repo.githubRepoId,
        fullName: `${a.org.login}/renamed`,
        defaultBranch: "dev",
      },
    ]);
    expect(readded).toMatchObject({ enabled: false, removedFromInstallationAt: null });
    expect(await latestAudit(a)).toMatchObject({ action: "repository.readded" });
  });

  it("discovers a workflow's triggers and environment use, and keeps them when a later sync can't tell", async () => {
    const workflowId = githubId();

    const [discovered] = await a.system.workflows.syncInstalled(a.repo.id, [
      {
        githubWorkflowId: workflowId,
        path: ".github/workflows/ci.yml",
        name: "CI",
        triggers: ["push", "pull_request"],
        usesEnvironment: false,
      },
    ]);
    expect(discovered).toMatchObject({
      triggers: ["push", "pull_request"],
      usesEnvironment: false,
    });
    expect(await latestAudit(a)).toMatchObject({ action: "workflow.discovered" });

    // A later sync that can't fetch the file's content (undefined) keeps the known facts.
    const [unchanged] = await a.system.workflows.syncInstalled(a.repo.id, [
      { githubWorkflowId: workflowId, path: ".github/workflows/ci.yml", name: "CI" },
    ]);
    expect(unchanged).toMatchObject({ triggers: ["push", "pull_request"], usesEnvironment: false });

    // A sync that *can* fetch it updates the stored facts and writes one audit row.
    const countBeforeUpdate = await auditCount(a);
    const [updated] = await a.system.workflows.syncInstalled(a.repo.id, [
      {
        githubWorkflowId: workflowId,
        path: ".github/workflows/ci.yml",
        name: "CI",
        triggers: ["workflow_dispatch"],
        usesEnvironment: true,
      },
    ]);
    expect(updated).toMatchObject({ triggers: ["workflow_dispatch"], usesEnvironment: true });
    expect(await auditCount(a)).toBe(countBeforeUpdate + 1);
    expect(await latestAudit(a)).toMatchObject({ action: "workflow.updated" });
  });

  it("applies the CI-looking pre-selection only at discovery, never on a later sync", async () => {
    const workflowId = githubId();
    const workflow = { githubWorkflowId: workflowId, path: ".github/workflows/ci.yml", name: "CI" };

    const [discovered] = await a.system.workflows.syncInstalled(a.repo.id, [
      { ...workflow, selected: true },
    ]);
    expect(discovered).toMatchObject({ selected: true });

    // An admin then turns it off on /[org]/repos/[repo]...
    await a.system.workflows.setSelected(present(discovered, "discovered workflow").id, false);

    // ...and a later sync passing `selected: true` again (the heuristic re-run on new facts)
    // must not flip the admin's choice back.
    const [resynced] = await a.system.workflows.syncInstalled(a.repo.id, [
      { ...workflow, selected: true },
    ]);
    expect(resynced).toMatchObject({ selected: false });
  });

  it("records installs, reinstalls, renames and status changes", async () => {
    const githubAccountId = githubId();
    const login = uniqueLogin();
    const input = {
      githubAccountId,
      login,
      accountType: "ORG" as const,
      installationId: githubId(),
    };
    const org = await installs.upsert({ ...input, installerGithubId: 42n });
    const tenant = { ...a, org };
    expect(org).toMatchObject({
      slug: login.toLowerCase(),
      status: "ACTIVE",
      installerGithubId: 42n,
    });
    expect(await latestAudit(tenant)).toMatchObject({
      actorType: "SYSTEM",
      action: "organization.installed",
      metadata: { installationId: String(input.installationId) },
    });

    await installs.upsert(input);
    expect(await auditCount(tenant)).toBe(1);

    await expect(installs.setStatus(input.installationId, "SUSPENDED")).resolves.toMatchObject({
      status: "SUSPENDED",
    });
    expect(await latestAudit(tenant)).toMatchObject({
      action: "organization.suspended",
      metadata: { from: "ACTIVE", to: "SUSPENDED" },
    });
    await installs.setStatus(input.installationId, "SUSPENDED");
    expect(await auditCount(tenant)).toBe(2);
    await installs.setStatus(input.installationId, "ACTIVE");
    expect(await latestAudit(tenant)).toMatchObject({ action: "organization.activated" });

    const newLogin = uniqueLogin();
    const renamed = await installs.upsert({ ...input, login: newLogin });
    expect(renamed).toMatchObject({
      login: newLogin,
      slug: newLogin.toLowerCase(),
      installerGithubId: 42n,
    });
    const renameEntry = await latestAudit(tenant);
    expect(renameEntry?.action).toBe("organization.updated");
    expect(renameEntry?.metadata).toEqual({
      installationId: String(input.installationId),
      changes: { login: { from: login, to: newLogin } },
    });

    await installs.setStatus(input.installationId, "UNINSTALLED");
    expect(await latestAudit(tenant)).toMatchObject({ action: "organization.uninstalled" });
    const newInstallationId = githubId();
    const reinstalled = await installs.upsert({
      ...input,
      login: newLogin,
      installationId: newInstallationId,
      installerGithubId: 43n,
    });
    expect(reinstalled).toMatchObject({ id: org.id, status: "ACTIVE", installerGithubId: 43n });
    const reinstallEntry = await latestAudit(tenant);
    expect(reinstallEntry?.action).toBe("organization.reinstalled");
    expect(reinstallEntry?.metadata).toEqual({
      installationId: String(newInstallationId),
      changes: {
        status: { from: "UNINSTALLED", to: "ACTIVE" },
        installationId: { from: String(input.installationId), to: String(newInstallationId) },
        installerGithubId: { from: "42", to: "43" },
      },
    });

    await expect(installs.setStatus(githubId(), "SUSPENDED")).resolves.toBeNull();
  });

  it("pages through the audit log, newest first", async () => {
    for (const enabled of [true, false, true]) {
      await a.asAdmin.repositories.setEnabled(a.repo.id, enabled);
    }
    const all = await a.asAdmin.audit.list();
    const [first, second] = await a.asAdmin.audit.list({ take: 2 });
    const next = await a.asAdmin.audit.list({ take: 2, before: present(second, "entry").id });

    expect(all.map((entry) => entry.action).slice(0, 3)).toEqual([
      "repository.enabled",
      "repository.disabled",
      "repository.enabled",
    ]);
    expect([first, second, ...next]).toEqual(all.slice(0, 4));
    expect(() => a.asAdmin.audit.list({ take: 1000 })).toThrow(ZodError);
  });
});

describe("failures (SPEC §2.1)", () => {
  async function failureAudits(failureId: string): Promise<string[]> {
    const entries = await db.auditLog.findMany({
      where: { orgId: a.org.id, target: `failure:${failureId}` },
      orderBy: { id: "asc" },
    });
    return entries.map((entry) => entry.action);
  }

  it("opens one failure per commit, with a 5-minute collection window, and its failed jobs", async () => {
    const run = failedRun();
    const before = Date.now();

    const result = await a.system.failures.recordFailedRun(a.repo.id, run);

    expect(result.outcome).toBe("opened");
    expect(result.failure).toMatchObject({
      repoId: a.repo.id,
      headSha: run.headSha,
      headBranch: "main",
      status: "DETECTED",
      windowClosedAt: null,
    });
    const windowMs = result.failure.windowClosesAt.getTime() - before;
    expect(windowMs).toBeGreaterThan(4 * 60_000);
    expect(windowMs).toBeLessThanOrEqual(5 * 60_000 + 1_000);
    const stored = await a.asMember.failures.get(result.failure.id);
    expect(stored?.runs).toHaveLength(1);
    expect(stored?.runs[0]).toMatchObject({
      runId: run.runId,
      runAttempt: 1,
      workflowPath: ".github/workflows/ci.yml",
      conclusion: "failure",
      lateArrival: false,
      rerunByUs: false,
    });
    expect(stored?.runs[0]?.jobs).toMatchObject([{ name: "check", failedStep: "Test" }]);
    expect(await failureAudits(result.failure.id)).toEqual(["failure.detected"]);
  });

  it("attaches another workflow's failed run of the same commit to the same failure", async () => {
    const run = failedRun({ headSha: a.failure.headSha, workflowId: 12n, workflowName: "Lint" });

    const result = await a.system.failures.recordFailedRun(a.repo.id, run);

    expect(result).toMatchObject({ outcome: "attached", failure: { id: a.failure.id } });
    expect((await a.system.failures.findBySha(a.repo.id, a.failure.headSha))?.runs).toHaveLength(2);
    await expect(db.pipelineFailure.count({ where: { repoId: a.repo.id } })).resolves.toBe(1);
  });

  it("ignores a redelivery or an older attempt, and updates the run for a newer failed attempt", async () => {
    const countBefore = await auditCount(a);
    await expect(a.system.failures.recordFailedRun(a.repo.id, a.failureRun)).resolves.toMatchObject(
      { outcome: "unchanged" },
    );
    expect(await auditCount(a)).toBe(countBefore);

    const newJob = {
      githubJobId: githubId(),
      name: "test",
      failedStep: "Run tests",
      htmlUrl: null,
    };
    const result = await a.system.failures.recordFailedRun(a.repo.id, {
      ...a.failureRun,
      runAttempt: 2,
      conclusion: "timed_out",
      jobs: [newJob],
    });

    expect(result).toMatchObject({
      outcome: "updated",
      run: { runAttempt: 2, conclusion: "timed_out" },
    });
    const stored = await a.system.failures.get(a.failure.id);
    expect(stored?.runs).toHaveLength(1);
    expect(stored?.runs[0]?.jobs.map((job) => job.name)).toEqual(["test"]);
    await expect(
      a.system.failures.recordFailedRun(a.repo.id, { ...a.failureRun, runAttempt: 1 }),
    ).resolves.toMatchObject({ outcome: "unchanged" });
  });

  it("marks a failure FLAKY once every failed run passed on a re-run, not before", async () => {
    const second = failedRun({ headSha: a.failure.headSha, workflowId: 12n });
    await a.system.failures.recordFailedRun(a.repo.id, second);

    await expect(
      a.system.failures.recordPassedRun(a.repo.id, { runId: a.failureRun.runId, runAttempt: 2 }),
    ).resolves.toMatchObject({ outcome: "passed", failure: { status: "DETECTED" } });
    await expect(
      a.system.failures.recordPassedRun(a.repo.id, { runId: second.runId, runAttempt: 2 }),
    ).resolves.toMatchObject({ outcome: "flaky", failure: { status: "FLAKY" } });
    await expect(
      a.system.failures.recordPassedRun(a.repo.id, { runId: second.runId, runAttempt: 2 }),
    ).resolves.toMatchObject({ outcome: "unchanged" });
  });

  it("doesn't mark a failure FLAKY once something was dispatched for it", async () => {
    await db.pipelineFailure.update({ where: { id: a.failure.id }, data: { status: "HEALING" } });

    await expect(
      a.system.failures.recordPassedRun(a.repo.id, { runId: a.failureRun.runId, runAttempt: 2 }),
    ).resolves.toMatchObject({ outcome: "passed", failure: { status: "HEALING" } });
  });

  it("ignores a passing run it never saw fail", async () => {
    await expect(
      a.system.failures.recordPassedRun(a.repo.id, { runId: githubId(), runAttempt: 1 }),
    ).resolves.toBeNull();
  });

  it("closes the window once, and marks runs attached after it as late arrivals", async () => {
    const closed = await a.system.failures.closeWindow(a.failure.id);
    const again = await a.system.failures.closeWindow(a.failure.id);

    expect(closed.windowClosedAt).toBeInstanceOf(Date);
    expect(again.windowClosedAt).toEqual(closed.windowClosedAt);
    const late = await a.system.failures.recordFailedRun(
      a.repo.id,
      failedRun({ headSha: a.failure.headSha, workflowId: 13n }),
    );
    expect(late.run.lateArrival).toBe(true);
    expect(await failureAudits(a.failure.id)).toEqual([
      "failure.detected",
      "failure.window_closed",
      "failure.run_attached",
    ]);
  });

  it("opens exactly one failure when several workflows' failures for a commit arrive at once", async () => {
    const headSha = sha();
    const runs = [11n, 12n, 13n, 14n].map((workflowId) => failedRun({ headSha, workflowId }));

    const results = await Promise.all(
      runs.map((run) => a.system.failures.recordFailedRun(a.repo.id, run)),
    );

    expect(results.map((r) => r.outcome).sort()).toEqual([
      "attached",
      "attached",
      "attached",
      "opened",
    ]);
    expect(new Set(results.map((r) => r.failure.id)).size).toBe(1);
    const failure = present(results[0], "result").failure;
    expect(await failureAudits(failure.id)).toHaveLength(4);
    await expect(db.failedRun.count({ where: { failureId: failure.id } })).resolves.toBe(4);
  });

  it("records a run once when the same delivery is processed twice at the same time", async () => {
    const run = failedRun();

    await Promise.all([
      a.system.failures.recordFailedRun(a.repo.id, run),
      a.system.failures.recordFailedRun(a.repo.id, run),
    ]);

    await expect(
      db.failedRun.count({ where: { repoId: a.repo.id, runId: run.runId } }),
    ).resolves.toBe(1);
    await expect(db.failedJob.count({ where: { failedRun: { runId: run.runId } } })).resolves.toBe(
      1,
    );
  });

  it("stores a job's redacted error window, visible to members, with only counts in the audit", async () => {
    await a.system.failures.recordJobTriage(a.failedJobId, {
      errorWindow: "src/receipt.ts(1,25): error TS2305",
      redactions: { jwt: 1 },
    });

    const stored = await a.asMember.failures.get(a.failure.id);
    expect(stored?.runs[0]?.jobs[0]?.errorWindow).toBe("src/receipt.ts(1,25): error TS2305");
    const entry = await db.auditLog.findFirst({
      where: { orgId: a.org.id, action: "failure.job_triaged" },
    });
    expect(JSON.stringify(entry?.metadata)).not.toContain("TS2305");
    await expect(
      a.system.failures.recordJobTriage(a.failedJobId, {
        errorWindow: "x".repeat(200_001),
      }),
    ).rejects.toThrow(ZodError);
  });

  it("stores a job's classification and the failure's, and TRIAGED only moves on from DETECTED", async () => {
    await a.system.failures.recordJobTriage(a.failedJobId, {
      errorWindow: "error TS2305",
      classification: { category: "typecheck", confidence: 0.95, summary: "tsc: TS2305" },
    });
    const triaged = await a.system.failures.recordTriage(a.failure.id, {
      category: "typecheck",
      confidence: 0.95,
      summary: "tsc: TS2305",
    });

    expect(triaged).toMatchObject({ status: "TRIAGED", category: "TYPECHECK", confidence: 0.95 });
    const stored = await a.asMember.failures.get(a.failure.id);
    expect(stored?.runs[0]?.jobs[0]).toMatchObject({
      category: "TYPECHECK",
      summary: "tsc: TS2305",
    });

    await db.pipelineFailure.update({ where: { id: a.failure.id }, data: { status: "FLAKY" } });
    await expect(
      a.system.failures.recordTriage(a.failure.id, {
        category: "test",
        confidence: 0.9,
        summary: "x",
      }),
    ).resolves.toMatchObject({ status: "FLAKY", category: "TEST" });
  });

  it("records a model call's tokens and cost exactly", async () => {
    const call = await a.system.failures.recordModelCall(a.failure.id, {
      ...modelCall(),
      cacheReadTokens: 4000,
      costUsd: 0.0123456,
    });

    expect(call).toMatchObject({ orgId: a.org.id, failureId: a.failure.id, cacheReadTokens: 4000 });
    expect(call.costUsd.toString()).toBe("0.012346");
    await expect(
      a.system.failures.recordModelCall(a.failure.id, {
        ...modelCall(),
        outcome: "maybe" as "valid",
      }),
    ).rejects.toThrow(ZodError);
  });

  it("rejects malformed runs before touching the database", async () => {
    const before = await snapshot(a);

    for (const bad of [
      failedRun({ headSha: "not-a-sha" }),
      { ...failedRun(), conclusion: "cancelled" },
      failedRun({ htmlUrl: "javascript:alert(1)" }),
      failedRun({ runAttempt: 0 }),
    ]) {
      await expect(
        a.system.failures.recordFailedRun(a.repo.id, bad as FailedRunInput),
      ).rejects.toThrow(ZodError);
    }
    await expect(a.system.failures.findBySha(a.repo.id, "' OR 1=1 --")).resolves.toBeNull();
    expect(await snapshot(a)).toEqual(before);
  });
});

describe("input validation", () => {
  it("rejects oversized batches and malformed GitHub data before touching the database", async () => {
    const before = await snapshot(a);
    const tooMany = Array.from({ length: SYNC_BATCH_LIMIT + 1 }, (_, i) => ({
      githubRepoId: BigInt(i + 1),
      fullName: `${a.org.login}/r${String(i)}`,
      defaultBranch: "main",
    }));

    await expect(a.system.repositories.syncInstalled(tooMany)).rejects.toThrow(ZodError);
    await expect(
      a.system.repositories.markRemoved(tooMany.map((repo) => repo.githubRepoId)),
    ).rejects.toThrow(ZodError);
    await expect(
      a.system.repositories.syncInstalled([
        { githubRepoId: githubId(), fullName: "../../etc/passwd", defaultBranch: "main" },
      ]),
    ).rejects.toThrow(ZodError);
    await expect(
      installs.upsert({
        githubAccountId: githubId(),
        login: "bad login!",
        accountType: "ORG",
        installationId: githubId(),
      }),
    ).rejects.toThrow(ZodError);
    await expect(installs.setStatus(-1n, "SUSPENDED")).rejects.toThrow(ZodError);
    expect(await snapshot(a)).toEqual(before);
  });
});
