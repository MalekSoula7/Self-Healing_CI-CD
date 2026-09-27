// Needs Postgres. The sign-in path as /auth/complete wires it: Better Auth on the Prisma adapter
// against the migrated test database, then the OWNER binding (SPEC §5.2) through Better Auth's
// own token decryption and our GitHub wrapper. GitHub is msw (started here: integration tests
// have no shared msw server).
import { randomInt, randomUUID } from "node:crypto";
import { forMember, installations } from "@pipeheal/db";
import { createTestDb } from "@pipeheal/db/testing";
import { listUserInstallationIds } from "@pipeheal/github";
import { createLogger } from "@pipeheal/shared/logger";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN,
  BASE_URL,
  REFRESH_TOKEN,
  TEST_SECRET,
  cookieHeader,
  gitHubOAuthHandlers,
  signInWithGitHub,
} from "@/testing/github-oauth";
import { createAuthOptions } from "./options";
import { bindVerifiedOwnerships } from "./owner-binding";

const db = createTestDb();
const github = setupServer();

beforeAll(() => {
  github.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  github.resetHandlers();
});
afterAll(async () => {
  github.close();
  await db.$disconnect();
});

const auth = betterAuth(
  createAuthOptions({
    baseURL: BASE_URL,
    secret: TEST_SECRET,
    github: { clientId: "Iv23-test-client", clientSecret: "test-client-secret" },
    database: prismaAdapter(db, { provider: "postgresql" }),
    logger: createLogger({ level: "silent", service: "test" }),
  }),
);

function githubId(): number {
  return randomInt(1, 2 ** 40);
}

async function installedOrg(installerGithubId: number) {
  return installations(db, "webhook").upsert({
    githubAccountId: BigInt(githubId()),
    login: `T${randomUUID().replaceAll("-", "").slice(0, 20)}`,
    accountType: "ORG",
    installationId: BigInt(githubId()),
    installerGithubId: BigInt(installerGithubId),
  });
}

function githubUser(id: number) {
  return { id, login: `dev-${String(id)}`, name: null, email: `dev-${String(id)}@example.test` };
}

describe("GitHub sign-in on Postgres", () => {
  it("creates the user, an encrypted account and a session", async () => {
    const id = githubId();
    github.use(...gitHubOAuthHandlers(githubUser(id), []));

    const { callback } = await signInWithGitHub(auth);

    expect(callback.status).toBe(302);
    const account = await db.account.findFirstOrThrow({
      where: { providerId: "github", accountId: String(id) },
      include: { user: { include: { sessions: true } } },
    });
    expect(account.user).toMatchObject({
      login: `dev-${String(id)}`,
      email: `dev-${String(id)}@example.test`,
    });
    expect(account.user.sessions).toHaveLength(1);
    expect(account.accessToken).not.toContain(ACCESS_TOKEN);
    expect(account.refreshToken).not.toContain(REFRESH_TOKEN);
  });

  it("binds the installer as OWNER after GitHub confirms, using their decrypted token", async () => {
    const id = githubId();
    const org = await installedOrg(id);
    const seenAuthorization: (string | null)[] = [];
    github.use(
      ...gitHubOAuthHandlers(githubUser(id), []),
      http.get("https://api.github.com/user/installations", ({ request }) => {
        seenAuthorization.push(request.headers.get("authorization"));
        return HttpResponse.json({
          total_count: 1,
          installations: [{ id: Number(org.installationId) }],
        });
      }),
    );
    const { callback } = await signInWithGitHub(auth);
    const headers = new Headers({ cookie: cookieHeader(callback) });
    const session = await auth.api.getSession({ headers });
    const userId = session?.user.id ?? "";

    const bound = await bindVerifiedOwnerships(
      {
        db,
        getAccessToken: async (accountId) =>
          (await auth.api.getAccessToken({ body: { accountId }, headers })).accessToken,
        listInstallationIds: (token) => listUserInstallationIds(token, { retries: 0 }),
      },
      userId,
    );

    expect(bound).toEqual([org.id]);
    expect(seenAuthorization).toEqual([`token ${ACCESS_TOKEN}`]);
    expect((await forMember(db, { orgSlug: org.slug, userId }))?.role).toBe("OWNER");
  });

  it("doesn't bind a signed-in user who isn't the installer, even if GitHub lists the installation", async () => {
    const org = await installedOrg(githubId());
    const id = githubId();
    github.use(
      ...gitHubOAuthHandlers(githubUser(id), []),
      http.get("https://api.github.com/user/installations", () =>
        HttpResponse.json({ total_count: 1, installations: [{ id: Number(org.installationId) }] }),
      ),
    );
    const { callback } = await signInWithGitHub(auth);
    const headers = new Headers({ cookie: cookieHeader(callback) });
    const userId = (await auth.api.getSession({ headers }))?.user.id ?? "";

    const bound = await bindVerifiedOwnerships(
      {
        db,
        getAccessToken: async (accountId) =>
          (await auth.api.getAccessToken({ body: { accountId }, headers })).accessToken,
        listInstallationIds: (token) => listUserInstallationIds(token, { retries: 0 }),
      },
      userId,
    );

    expect(bound).toEqual([]);
    await expect(forMember(db, { orgSlug: org.slug, userId })).resolves.toBeNull();
  });
});
