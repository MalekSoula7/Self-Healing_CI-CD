// Needs Postgres: `docker compose up -d` (runs against the `pipeheal_test` database).
import { randomInt, randomUUID } from "node:crypto";
import { installations, type Organization, type Role } from "@pipeheal/db";
import { createTestDb } from "@pipeheal/db/testing";
import { afterAll, describe, expect, it } from "vitest";
import { resolveOrgAccess } from "./access";
import { bindVerifiedOwnerships, type OwnerBindingDeps } from "./owner-binding";

const db = createTestDb();
const installs = installations(db, "test");

afterAll(async () => {
  await db.$disconnect();
});

function githubId(): bigint {
  return BigInt(randomInt(1, 2 ** 47));
}

async function createOrg(installerGithubId?: bigint): Promise<Organization> {
  return installs.upsert({
    githubAccountId: githubId(),
    login: `T${randomUUID().replaceAll("-", "").slice(0, 20)}`,
    accountType: "ORG",
    installationId: githubId(),
    ...(installerGithubId === undefined ? {} : { installerGithubId }),
  });
}

async function createUser(githubUserId?: bigint): Promise<string> {
  const id = randomUUID();
  await db.user.create({ data: { id, name: "Test User", email: `${id}@example.test` } });
  if (githubUserId !== undefined) {
    await db.account.create({
      data: { id: randomUUID(), userId: id, providerId: "github", accountId: String(githubUserId) },
    });
  }
  return id;
}

async function addMember(org: Organization, role: Role): Promise<string> {
  const userId = await createUser();
  await db.membership.create({ data: { orgId: org.id, userId, role } });
  return userId;
}

describe("resolveOrgAccess", () => {
  it("gives members their scope, by slug in any case", async () => {
    const org = await createOrg();
    const userId = await addMember(org, "MEMBER");

    const scope = await resolveOrgAccess(db, userId, org.login.toUpperCase());

    expect(scope?.org.id).toBe(org.id);
    expect(scope?.role).toBe("MEMBER");
  });

  it("gives nothing to non-members, for unknown orgs, or below the required role", async () => {
    const [org, other] = await Promise.all([createOrg(), createOrg()]);
    const member = await addMember(org, "MEMBER");
    const outsider = await addMember(other, "OWNER");

    await expect(resolveOrgAccess(db, outsider, org.slug)).resolves.toBeNull();
    await expect(resolveOrgAccess(db, member, "no-such-org")).resolves.toBeNull();
    await expect(resolveOrgAccess(db, member, org.slug, "ADMIN")).resolves.toBeNull();
    await expect(
      resolveOrgAccess(db, await addMember(org, "ADMIN"), org.slug, "ADMIN"),
    ).resolves.not.toBeNull();
  });
});

describe("bindVerifiedOwnerships", () => {
  function fakeGitHub(accessible: bigint[]) {
    const calls = { tokens: [] as string[], lists: [] as string[] };
    const deps: OwnerBindingDeps = {
      db,
      getAccessToken: (accountRowId) => {
        calls.tokens.push(accountRowId);
        return Promise.resolve("ghu_fake");
      },
      listInstallationIds: (accessToken) => {
        calls.lists.push(accessToken);
        return Promise.resolve(accessible);
      },
    };
    return { deps, calls };
  }

  it("makes the installer OWNER when GitHub confirms, with their own token", async () => {
    const installer = githubId();
    const org = await createOrg(installer);
    const userId = await createUser(installer);
    const { deps, calls } = fakeGitHub([org.installationId]);

    await expect(bindVerifiedOwnerships(deps, userId)).resolves.toEqual([org.id]);
    expect((await resolveOrgAccess(db, userId, org.slug, "OWNER"))?.role).toBe("OWNER");
    expect(calls.tokens).toHaveLength(1);
    expect(calls.lists).toEqual(["ghu_fake"]);
  });

  it("doesn't call GitHub when the user installed nothing (almost every sign-in)", async () => {
    await createOrg(githubId());
    const userId = await createUser(githubId());
    const { deps, calls } = fakeGitHub([]);

    await expect(bindVerifiedOwnerships(deps, userId)).resolves.toEqual([]);
    expect(calls).toEqual({ tokens: [], lists: [] });
  });

  it("binds nothing when GitHub doesn't list the installation", async () => {
    const installer = githubId();
    const org = await createOrg(installer);
    const userId = await createUser(installer);
    const { deps } = fakeGitHub([githubId()]);

    await expect(bindVerifiedOwnerships(deps, userId)).resolves.toEqual([]);
    await expect(resolveOrgAccess(db, userId, org.slug)).resolves.toBeNull();
  });

  it("does nothing for a user without a GitHub account", async () => {
    const { deps, calls } = fakeGitHub([]);

    await expect(bindVerifiedOwnerships(deps, await createUser())).resolves.toEqual([]);
    expect(calls.tokens).toEqual([]);
  });

  it("lets GitHub failures propagate (sign-in logs them and continues)", async () => {
    const installer = githubId();
    await createOrg(installer);
    const userId = await createUser(installer);
    const deps: OwnerBindingDeps = {
      db,
      getAccessToken: () => Promise.resolve("ghu_fake"),
      listInstallationIds: () => Promise.reject(new Error("GitHub is down")),
    };

    await expect(bindVerifiedOwnerships(deps, userId)).rejects.toThrow("GitHub is down");
  });
});
