// Runs the real Better Auth OAuth flow (sign-in → GitHub → callback) with our options, against
// msw's GitHub and an in-memory database. Postgres and the OWNER binding: sign-in.int.test.ts.
import { createLogger } from "@pipeheal/shared/logger";
import { mockServer } from "@pipeheal/shared/testing";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN,
  BASE_URL,
  REFRESH_TOKEN,
  TEST_SECRET,
  cookieHeader,
  gitHubOAuthHandlers,
  signInWithGitHub as signIn,
  type GitHubEmail,
  type GitHubUser,
} from "@/testing/github-oauth";
import { COOKIE_PREFIX, createAuthOptions } from "./options";

let store: Record<string, Record<string, unknown>[]>;
let logLines: string[];

function createTestAuth() {
  return betterAuth(
    createAuthOptions({
      baseURL: BASE_URL,
      secret: TEST_SECRET,
      github: { clientId: "Iv23-test-client", clientSecret: "test-client-secret" },
      database: memoryAdapter(store),
      logger: createLogger(
        { level: "debug", service: "test" },
        { write: (line) => logLines.push(line) },
      ),
    }),
  );
}

function mockGitHub(user: GitHubUser, emails?: GitHubEmail[]) {
  mockServer.use(...gitHubOAuthHandlers(user, emails));
}

const octo: GitHubUser = { id: 4242, login: "Octo-Dev", name: "Octo Dev", email: null };

beforeEach(() => {
  store = { user: [], session: [], account: [], verification: [] };
  logLines = [];
});

describe("GitHub sign-in", () => {
  it("sends the user to GitHub with our client ID and callback, and no OAuth scopes", async () => {
    mockGitHub(octo);
    const { authorize } = await signIn(createTestAuth());

    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(authorize.searchParams.get("client_id")).toBe("Iv23-test-client");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${BASE_URL}/api/auth/callback/github`);
    expect(authorize.searchParams.get("scope") ?? "").toBe("");
    expect(authorize.searchParams.get("state")).toBeTruthy();
  });

  it("creates the user with their GitHub login and verified primary email", async () => {
    mockGitHub(octo);
    const { callback } = await signIn(createTestAuth());

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/auth/complete");
    expect(store.user).toMatchObject([
      { name: "Octo Dev", email: "octo@example.test", emailVerified: true, login: "Octo-Dev" },
    ]);
    expect(store.account).toMatchObject([{ providerId: "github", accountId: "4242" }]);
  });

  it("sets an httpOnly, SameSite=Lax session cookie with our prefix", async () => {
    mockGitHub(octo);
    const { callback } = await signIn(createTestAuth());

    const session = callback.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`${COOKIE_PREFIX}.session_token=`));
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
  });

  it("stores GitHub tokens encrypted, and decrypts them for our own use (D8)", async () => {
    mockGitHub(octo);
    const auth = createTestAuth();
    const { callback } = await signIn(auth);

    const [account] = store.account ?? [];
    expect(JSON.stringify(account)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(account)).not.toContain(REFRESH_TOKEN);
    const token = await auth.api.getAccessToken({
      body: { accountId: String(account?.id) },
      headers: new Headers({ cookie: cookieHeader(callback) }),
    });
    expect(token.accessToken).toBe(ACCESS_TOKEN);
  });

  it("refreshes name, avatar and login on the next sign-in (logins can be renamed)", async () => {
    mockGitHub(octo);
    const auth = createTestAuth();
    await signIn(auth);
    mockGitHub({ ...octo, login: "Octo-Renamed", name: null });
    await signIn(auth);

    expect(store.user).toMatchObject([{ login: "Octo-Renamed", name: "Octo-Renamed" }]);
    expect(store.account).toHaveLength(1);
  });

  it("lets no one edit their profile fields, which only come from GitHub", async () => {
    mockGitHub(octo);
    const auth = createTestAuth();
    const { callback } = await signIn(auth);

    const response = await auth.handler(
      new Request(`${BASE_URL}/api/auth/update-user`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE_URL,
          cookie: cookieHeader(callback),
        },
        body: JSON.stringify({ login: "someone-else", name: "Someone Else" }),
      }),
    );

    expect(response.status).toBe(404);
    expect(store.user).toMatchObject([{ login: "Octo-Dev", name: "Octo Dev" }]);
  });

  it("never attaches a GitHub identity to an existing user with the same email", async () => {
    store.user = [
      {
        id: "existing-user",
        name: "Someone",
        email: "octo@example.test",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    mockGitHub(octo);
    const { callback } = await signIn(createTestAuth());

    expect(callback.headers.get("location")).toMatch(/error=account_not_linked/);
    expect(store.account).toEqual([]);
    expect(store.session).toEqual([]);
  });

  it("refuses sign-in when GitHub gives no email (the App lacks Email addresses: read)", async () => {
    mockGitHub(octo, []);
    const { callback } = await signIn(createTestAuth());

    expect(callback.headers.get("location")).toMatch(/error=email_not_found/);
    expect(store.user).toEqual([]);
  });

  it("logs no token, secret or code", async () => {
    mockGitHub(octo);
    mockServer.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({ error: "bad_verification_code", error_description: ACCESS_TOKEN }),
      ),
    );
    await signIn(createTestAuth());

    const logged = logLines.join("\n");
    expect(logLines.length).toBeGreaterThan(0);
    expect(logged).not.toContain(ACCESS_TOKEN);
    expect(logged).not.toContain("test-client-secret");
  });
});
