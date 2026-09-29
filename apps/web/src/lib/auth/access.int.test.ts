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

async function createOrg(
  installerGithubId?: bigint,
  account: { accountType: "ORG" | "USER"; githubAccountId?: bigint } = { accountType: "ORG" },
): Promise<Organization> {
  return installs.upsert({
    githubAccountId: account.githubAccountId ?? githubId(),
    login: `T${randomUUID().replaceAll("-", "").slice(0, 20)}`,
    accountType: account.accountType,
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
  function fakeGitHub(installationIds: bigint[], adminOrgIds: bigint[] = []) {
    const calls = { tokens: [] as string[], installations: [] as string[], admin: [] as string[] };
    const deps: OwnerBindingDeps = {
      db,
      getAccessToken: (accountRowId) => {
        calls.tokens.push(accountRowId);
        return Promise.resolve("ghu_fake");
      },
      listInstallationIds: (accessToken) => {
        calls.installations.push(accessToken);
        return Promise.resolve(installationIds);
      },
      listAdminOrgIds: (accessToken) => {
        calls.admin.push(accessToken);
        return Promise.resolve(adminOrgIds);
      },
    };
    return { deps, calls };
  }

  it("makes an org admin who installed the App OWNER, asking GitHub with their own token", async () => {
    const installer = githubId();
    const org = await createOrg(installer);
    const userId = await createUser(installer);
    const { deps, calls } = fakeGitHub([org.installationId], [org.githubAccountId]);

    await expect(bindVerifiedOwnerships(deps, userId)).resolves.toEqual([org.id]);
    expect((await resolveOrgAccess(db, userId, org.slug, "OWNER"))?.role).toBe("OWNER");
    expect(calls).toEqual({
      tokens: [expect.any(String)],
      installations: ["ghu_fake"],
      admin: ["ghu_fake"],
    });
  });

  // D10: a repository admin can install the App on an org's repositories.
  it("doesn't bind an installer who isn't an org admin", async () => {
    const installer = githubId();
    const org = await createOrg(installer);
    const userId = await createUser(installer);
    const { deps } = fakeGitHub([org.installationId], []);

    await expect(bindVerifiedOwnerships(deps, userId)).resolves.toEqual([]);
    await expect(resolveOrgAccess(db, userId, org.slug)).resolves.toBeNull();
  });

  it("binds a personal account's owner without asking about org memberships", async () => {
    const owner = githubId();
    const account = await createOrg(owner, { accountType: "USER", githubAccountId: owner });
    const userId = await createUser(owner);
    const { deps, calls } = fakeGitHub([account.installationId]);

    await expect(bindVerifiedOwnerships(deps, userId)).resolves.toEqual([account.id]);
    expect(calls.admin).toEqual([]);
  });

  it("doesn't call GitHub when the user installed nothing (almost every sign-in)", async () => {
    await createOrg(githubId());
    const userId = await createUser(githubId());
    const { deps, calls } = fakeGitHub([]);

    await expect(bindVerifiedOwnerships(deps, userId)).resolves.toEqual([]);
    expect(calls).toEqual({ tokens: [], installations: [], admin: [] });
  });

  it("binds nothing when GitHub doesn't list the installation", async () => {
    const installer = githubId();
    const org = await createOrg(installer);
    const userId = await createUser(installer);
    const { deps } = fakeGitHub([githubId()], [org.githubAccountId]);

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
      listAdminOrgIds: () => Promise.resolve([]),
    };

    await expect(bindVerifiedOwnerships(deps, userId)).rejects.toThrow("GitHub is down");
  });
});
