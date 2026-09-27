// Test-only: drives Better Auth's GitHub OAuth flow (sign-in → callback) against msw handlers
// standing in for github.com and api.github.com.
import { http, HttpResponse, type RequestHandler } from "msw";

export const BASE_URL = "http://localhost:3000";
export const ACCESS_TOKEN = "ghu_accessTokenForTests000000000000000000";
export const REFRESH_TOKEN = "ghr_refreshTokenForTests0000000000000000000000000000000000000000";
export const TEST_SECRET = "test-secret-with-at-least-32-characters!";

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
}

export interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

export function gitHubOAuthHandlers(
  user: GitHubUser,
  emails: GitHubEmail[] = [{ email: "octo@example.test", primary: true, verified: true }],
): RequestHandler[] {
  return [
    http.post("https://github.com/login/oauth/access_token", () =>
      HttpResponse.json({
        access_token: ACCESS_TOKEN,
        token_type: "bearer",
        scope: "",
        expires_in: 28_800,
        refresh_token: REFRESH_TOKEN,
        refresh_token_expires_in: 15_811_200,
      }),
    ),
    http.get("https://api.github.com/user", () =>
      HttpResponse.json({
        ...user,
        avatar_url: `https://avatars.githubusercontent.com/u/${String(user.id)}`,
      }),
    ),
    http.get("https://api.github.com/user/emails", () => HttpResponse.json(emails)),
  ];
}

export function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

interface AuthHandler {
  handler: (request: Request) => Promise<Response>;
}

/** Starts GitHub sign-in and completes the callback. Returns GitHub's authorize URL and the callback response. */
export async function signInWithGitHub(auth: AuthHandler) {
  const start = await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ provider: "github", callbackURL: "/auth/complete" }),
    }),
  );
  const { url } = (await start.json()) as { url: string };
  const authorize = new URL(url);
  const state = authorize.searchParams.get("state") ?? "";
  const callback = await auth.handler(
    new Request(`${BASE_URL}/api/auth/callback/github?code=test-code&state=${state}`, {
      headers: { cookie: cookieHeader(start) },
    }),
  );
  return { authorize, callback };
}
