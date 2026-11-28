// Needs Postgres: `docker compose up -d`. Runs against the `pipeheal_test` database that
// vitest.integration.globalSetup.ts recreated and migrated for this run.
import { randomInt, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { afterAll, describe, expect, inject, it } from "vitest";
import type { Prisma } from "./generated/prisma/client";
import { createTestDb, runPrisma } from "./testing";

const db = createTestDb();

afterAll(async () => {
  await db.$disconnect();
});

// Random positive IDs keep test files independent on the shared test database.
function githubId(): bigint {
  return BigInt(randomInt(1, 2 ** 47));
}

async function createOrg(data: Partial<Prisma.OrganizationUncheckedCreateInput> = {}) {
  const login = `Org-${randomUUID()}`;
  return db.organization.create({
    data: {
      githubAccountId: githubId(),
      installationId: githubId(),
      login,
      slug: login.toLowerCase(),
      accountType: "ORG",
      ...data,
    },
  });
}

async function createUser(data: Partial<Prisma.UserUncheckedCreateInput> = {}) {
  const id = randomUUID();
  return db.user.create({ data: { id, name: "Test User", email: `${id}@example.test`, ...data } });
}

async function createRepo(
  orgId: string,
  data: Partial<Prisma.RepositoryUncheckedCreateInput> = {},
) {
  return db.repository.create({
    data: {
      orgId,
      githubRepoId: githubId(),
      fullName: `owner/repo-${randomUUID()}`,
      defaultBranch: "main",
      ...data,
    },
  });
}

async function createWorkflow(
  orgId: string,
  repoId: string,
  data: Partial<Prisma.RepoWorkflowUncheckedCreateInput> = {},
) {
  return db.repoWorkflow.create({
    data: {
      orgId,
      repoId,
      githubWorkflowId: githubId(),
      path: ".github/workflows/ci.yml",
      name: "CI",
      triggers: ["push"],
      ...data,
    },
  });
}

const UNIQUE_VIOLATION = { code: "P2002" };
const FOREIGN_KEY_VIOLATION = { code: "P2003" };

describe("migrations", () => {
  it("apply every migration to an empty database", async () => {
    const migrationDirs = readdirSync(new URL("../prisma/migrations", import.meta.url), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const applied = await db.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY migration_name`;

    expect(migrationDirs.length).toBeGreaterThan(0);
    expect(applied.map((row) => row.migration_name)).toEqual(migrationDirs);
  });

  // Catches a schema.prisma change committed without its migration. Runs the Prisma CLI (and its
  // schema engine) as a subprocess: 3-5 s on Windows under a full test run, over Vitest's default.
  it("produce exactly the database described by schema.prisma", { timeout: 30_000 }, () => {
    const diff = runPrisma(
      [
        "migrate",
        "diff",
        "--from-config-datasource",
        "--to-schema",
        "prisma/schema.prisma",
        "--exit-code",
      ],
      inject("databaseUrl"),
    );
    expect(diff.output).not.toMatch(/\[\+\]|\[-\]|\[\*\]/);
    expect(diff.status).toBe(0);
  });
});

describe("unique constraints", () => {
  it("allow one organization per GitHub account, installation and slug", async () => {
    const org = await createOrg();

    await expect(createOrg({ githubAccountId: org.githubAccountId })).rejects.toMatchObject(
      UNIQUE_VIOLATION,
    );
    await expect(createOrg({ installationId: org.installationId })).rejects.toMatchObject(
      UNIQUE_VIOLATION,
    );
    await expect(createOrg({ slug: org.slug })).rejects.toMatchObject(UNIQUE_VIOLATION);
  });

  it("allow one membership per user and organization", async () => {
    const [orgA, orgB, user] = await Promise.all([createOrg(), createOrg(), createUser()]);
    await db.membership.create({ data: { orgId: orgA.id, userId: user.id, role: "OWNER" } });

    await expect(
      db.membership.create({ data: { orgId: orgA.id, userId: user.id, role: "MEMBER" } }),
    ).rejects.toMatchObject(UNIQUE_VIOLATION);
    await expect(
      db.membership.create({ data: { orgId: orgB.id, userId: user.id, role: "MEMBER" } }),
    ).resolves.toMatchObject({ orgId: orgB.id });
  });

  it("allow a GitHub repository once per organization, and again in another one", async () => {
    const [orgA, orgB] = await Promise.all([createOrg(), createOrg()]);
    const repo = await createRepo(orgA.id);

    await expect(createRepo(orgA.id, { githubRepoId: repo.githubRepoId })).rejects.toMatchObject(
      UNIQUE_VIOLATION,
    );
    // A transferred repository gets a new row in its new tenant; the old row keeps its history.
    await expect(createRepo(orgB.id, { githubRepoId: repo.githubRepoId })).resolves.toMatchObject({
      orgId: orgB.id,
    });
  });

  it("allow a GitHub workflow once per repository", async () => {
    const org = await createOrg();
    const repo = await createRepo(org.id);
    const workflow = await createWorkflow(org.id, repo.id);

    await expect(
      createWorkflow(org.id, repo.id, { githubWorkflowId: workflow.githubWorkflowId }),
    ).rejects.toMatchObject(UNIQUE_VIOLATION);
  });

  it("give each GitHub identity, email and session token to one user", async () => {
    const [userA, userB] = await Promise.all([createUser(), createUser()]);
    const accountId = String(githubId());
    const account = { providerId: "github", accountId };
    await db.account.create({ data: { id: randomUUID(), userId: userA.id, ...account } });
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + 60_000);
    await db.session.create({ data: { id: randomUUID(), userId: userA.id, token, expiresAt } });

    await expect(
      db.account.create({ data: { id: randomUUID(), userId: userB.id, ...account } }),
    ).rejects.toMatchObject(UNIQUE_VIOLATION);
    await expect(createUser({ email: userA.email })).rejects.toMatchObject(UNIQUE_VIOLATION);
    await expect(
      db.session.create({ data: { id: randomUUID(), userId: userB.id, token, expiresAt } }),
    ).rejects.toMatchObject(UNIQUE_VIOLATION);
  });

  it("record each webhook delivery once", async () => {
    const deliveryId = randomUUID();
    await db.webhookDelivery.create({ data: { deliveryId, event: "installation" } });

    await expect(
      db.webhookDelivery.create({ data: { deliveryId, event: "installation" } }),
    ).rejects.toMatchObject(UNIQUE_VIOLATION);
  });
});

describe("tenant integrity", () => {
  it("rejects a workflow whose organization differs from its repository's", async () => {
    const [orgA, orgB] = await Promise.all([createOrg(), createOrg()]);
    const repoOfA = await createRepo(orgA.id);

    await expect(createWorkflow(orgB.id, repoOfA.id)).rejects.toMatchObject(FOREIGN_KEY_VIOLATION);
  });

  it("stores GitHub IDs beyond 2^53 exactly", async () => {
    const huge = 2n ** 62n + 7n;
    const org = await createOrg({ githubAccountId: huge, installationId: huge - 1n });
    const repo = await createRepo(org.id, { githubRepoId: huge + 1n });

    const stored = await db.repository.findUniqueOrThrow({
      where: { id: repo.id },
      include: { org: true },
    });
    expect(stored.githubRepoId).toBe(huge + 1n);
    expect(stored.org.githubAccountId).toBe(huge);
    expect(stored.org.installationId).toBe(huge - 1n);
  });

  it("removes every tenant row with its organization", async () => {
    const [org, user] = await Promise.all([createOrg(), createUser()]);
    const repo = await createRepo(org.id);
    await createWorkflow(org.id, repo.id);
    await db.membership.create({ data: { orgId: org.id, userId: user.id, role: "ADMIN" } });
    await db.auditLog.create({
      data: { orgId: org.id, actorType: "SYSTEM", action: "test.created", target: "test" },
    });

    await db.organization.delete({ where: { id: org.id } });

    const where = { orgId: org.id };
    const remaining = await Promise.all([
      db.repository.count({ where }),
      db.repoWorkflow.count({ where }),
      db.membership.count({ where }),
      db.auditLog.count({ where }),
    ]);
    expect(remaining).toEqual([0, 0, 0, 0]);
    await expect(db.user.count({ where: { id: user.id } })).resolves.toBe(1);
  });

  it("removes a user's sessions, accounts and memberships with the user", async () => {
    const [org, user] = await Promise.all([createOrg(), createUser()]);
    await db.membership.create({ data: { orgId: org.id, userId: user.id, role: "MEMBER" } });
    await db.account.create({
      data: { id: randomUUID(), userId: user.id, providerId: "github", accountId: randomUUID() },
    });
    await db.session.create({
      data: {
        id: randomUUID(),
        userId: user.id,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await db.user.delete({ where: { id: user.id } });

    const where = { userId: user.id };
    const remaining = await Promise.all([
      db.membership.count({ where }),
      db.account.count({ where }),
      db.session.count({ where }),
    ]);
    expect(remaining).toEqual([0, 0, 0]);
    await expect(db.organization.count({ where: { id: org.id } })).resolves.toBe(1);
  });
});
