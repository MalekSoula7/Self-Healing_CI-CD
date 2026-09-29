// Needs Postgres: `docker compose up -d` (runs against the `pipeheal_test` database).
import { afterAll, describe, expect, it } from "vitest";
import { SEED_ORG_SLUG, SEED_USER_EMAIL, seed } from "./seed";
import { createTestDb } from "./testing";

const db = createTestDb();

afterAll(async () => {
  await db.$disconnect();
});

async function seededOrg() {
  return db.organization.findUniqueOrThrow({
    where: { slug: SEED_ORG_SLUG },
    include: {
      memberships: { include: { user: true } },
      repositories: { include: { workflows: true }, orderBy: { fullName: "asc" } },
      auditLogs: true,
    },
  });
}

describe("seed", () => {
  it("creates a demo organization with an owner, repositories and workflows", async () => {
    await seed(db);
    const org = await seededOrg();

    expect(org.memberships).toMatchObject([{ role: "OWNER", user: { email: SEED_USER_EMAIL } }]);
    expect(org.repositories.map((repo) => repo.fullName)).toEqual([
      `${SEED_ORG_SLUG}/demo-node`,
      `${SEED_ORG_SLUG}/demo-python`,
    ]);
    expect(org.repositories.flatMap((repo) => repo.workflows)).toHaveLength(3);
    expect(org.auditLogs).toMatchObject([{ actorType: "SYSTEM", action: "org.seeded" }]);
  });

  it("uses negative GitHub IDs, which no real GitHub object has", async () => {
    await seed(db);
    const org = await seededOrg();
    const ids = [
      org.githubAccountId,
      org.installationId,
      ...org.repositories.map((repo) => repo.githubRepoId),
      ...org.repositories.flatMap((repo) => repo.workflows.map((w) => w.githubWorkflowId)),
    ];

    expect(ids.every((id) => id < 0n)).toBe(true);
  });

  it("is idempotent and keeps changes made since the last run", async () => {
    await seed(db);
    const before = await seededOrg();
    const [repo] = before.repositories;
    if (repo === undefined) throw new Error("seed created no repository");
    await db.repository.update({ where: { id: repo.id }, data: { enabled: !repo.enabled } });

    await seed(db);
    const after = await seededOrg();

    expect(after.repositories).toHaveLength(before.repositories.length);
    expect(after.memberships).toHaveLength(1);
    expect(after.auditLogs).toHaveLength(1);
    expect(after.repositories[0]?.enabled).toBe(!repo.enabled);
  });
});
