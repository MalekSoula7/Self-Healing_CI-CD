// Needs Postgres: `docker compose up -d` (runs against the `pipeheal_test` database).
// Tests the wiring runOwnerBindingCheck adds on top of the already-covered bindVerifiedOwnerships
// (access.int.test.ts): building deps from Better Auth + GitHub, bounded options, and that a
// GitHub failure never throws (sign-in and onboarding must continue regardless).
import { randomInt, randomUUID } from "node:crypto";
import { installations, type Organization } from "@pipeheal/db";
import { createTestDb } from "@pipeheal/db/testing";
import { createLogger } from "@pipeheal/shared/logger";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Auth } from "./server";

const mocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  listInstallations: vi.fn(),
  listAdminOrgs: vi.fn(),
}));

vi.mock("@pipeheal/github", () => ({
  listUserInstallationIds: mocks.listInstallations,
  listUserAdminOrgIds: mocks.listAdminOrgs,
}));

const { runOwnerBindingCheck } = await import("./owner-binding");

const db = createTestDb();
const installs = installations(db, "test");

afterAll(async () => {
  await db.$disconnect();
});

function githubId(): bigint {
  return BigInt(randomInt(1, 2 ** 47));
}

async function createOrg(installerGithubId: bigint): Promise<Organization> {
  return installs.upsert({
    githubAccountId: githubId(),
    login: `T${randomUUID().replaceAll("-", "").slice(0, 20)}`,
    accountType: "ORG",
    installationId: githubId(),
    installerGithubId,
  });
}

async function createUser(githubUserId: bigint): Promise<string> {
  const id = randomUUID();
  await db.user.create({ data: { id, name: "Test User", email: `${id}@example.test` } });
  await db.account.create({
    data: { id: randomUUID(), userId: id, providerId: "github", accountId: String(githubUserId) },
  });
  return id;
}

function fakeAuth(): Auth {
  return { api: { getAccessToken: mocks.getAccessToken } } as unknown as Auth;
}

const logLines: string[] = [];
const logger = createLogger(
  { level: "debug", service: "test" },
  { write: (line: string) => logLines.push(line) },
);

beforeEach(() => {
  vi.clearAllMocks();
  logLines.length = 0;
  mocks.getAccessToken.mockResolvedValue({ accessToken: "ghu_decrypted" });
});

describe("runOwnerBindingCheck", () => {
  it("wires the user's own decrypted token into a bounded GitHub call, and binds", async () => {
    const installer = githubId();
    const org = await createOrg(installer);
    const userId = await createUser(installer);
    mocks.listInstallations.mockResolvedValue([org.installationId]);
    mocks.listAdminOrgs.mockResolvedValue([org.githubAccountId]);

    await expect(runOwnerBindingCheck(db, fakeAuth(), new Headers(), userId, logger)).resolves.toEqual(
      [org.id],
    );

    for (const call of [mocks.listInstallations, mocks.listAdminOrgs]) {
      expect(call).toHaveBeenCalledWith(
        "ghu_decrypted",
        expect.objectContaining({ retries: 1, timeoutMs: 5_000 }),
      );
    }
    expect(logLines.join("\n")).toContain("owner bound");
  });

  it("passes the account row ID Better Auth needs to decrypt the right token", async () => {
    const installer = githubId();
    await createOrg(installer);
    const userId = await createUser(installer);
    const { id: accountRowId } = await db.account.findFirstOrThrow({ where: { userId } });
    mocks.listInstallations.mockResolvedValue([]);

    await runOwnerBindingCheck(db, fakeAuth(), new Headers(), userId, logger);

    expect(mocks.getAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ body: { accountId: accountRowId } }),
    );
  });

  it("never throws, and logs no token, when GitHub fails", async () => {
    const installer = githubId();
    await createOrg(installer);
    const userId = await createUser(installer);
    const token = `ghu_${"x".repeat(36)}`;
    mocks.listInstallations.mockRejectedValue(new Error(`GitHub is down: ${token}`));

    await expect(
      runOwnerBindingCheck(db, fakeAuth(), new Headers(), userId, logger),
    ).resolves.toEqual([]);

    const logged = logLines.join("\n");
    expect(logged).toContain("owner check failed");
    expect(logged).not.toContain(token);
  });

  it("doesn't call GitHub when there's no candidate (almost every sign-in)", async () => {
    const userId = await createUser(githubId());

    await expect(runOwnerBindingCheck(db, fakeAuth(), new Headers(), userId, logger)).resolves.toEqual(
      [],
    );

    expect(mocks.getAccessToken).not.toHaveBeenCalled();
    expect(mocks.listInstallations).not.toHaveBeenCalled();
  });
});
