import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "./proxy";

function visit(path: string, cookie?: string) {
  const headers = cookie === undefined ? undefined : { cookie };
  return proxy(new NextRequest(`http://localhost:3000${path}`, { headers }));
}

describe("proxy", () => {
  it("sends signed-out visitors of an org page to /login, remembering where they were going", () => {
    const response = visit("/acme/repos?tab=all");

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/acme/repos?tab=all");
  });

  it.each(["pipeheal.session_token=abc", "__Secure-pipeheal.session_token=abc"])(
    "lets a request with a session cookie through (%s): layouts check it",
    (cookie) => {
      expect(visit("/acme", cookie).headers.get("location")).toBeNull();
    },
  );

  it("ignores another app's cookie", () => {
    expect(visit("/acme", "better-auth.session_token=abc").status).toBe(307);
  });

  // The matcher is a path-to-regexp pattern that is also a plain regular expression.
  const matcher = new RegExp(`^${String(config.matcher[0])}$`);
  it.each(["/acme", "/acme/repos", "/loginx", "/api-team"])("runs on %s", (path) => {
    expect(matcher.test(path)).toBe(true);
  });

  it.each([
    "/",
    "/login",
    "/login/x",
    "/api/health",
    "/api/auth/callback/github",
    "/auth/complete",
    "/_next/static/a.js",
    "/favicon.ico",
  ])("skips %s", (path) => {
    expect(matcher.test(path)).toBe(false);
  });
});
