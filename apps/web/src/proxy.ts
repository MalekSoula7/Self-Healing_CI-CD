// Optimistic check only (SPEC §5.2): signed-out visitors of /[org]/** go to /login. It looks for
// the session cookie without validating it; the session and the membership are checked in every
// org layout, page, route handler and server action (lib/auth/session.ts), never here alone.
import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_PREFIX } from "@/lib/auth/options";

export function proxy(request: NextRequest): NextResponse {
  if (getSessionCookie(request, { cookiePrefix: COOKIE_PREFIX }) !== null) {
    return NextResponse.next();
  }
  const login = new URL("/login", request.url);
  login.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything but the landing page, sign-in, API routes, Next.js assets and files.
  matcher: ["/((?!api/|auth/|login(?:/|$)|_next/|.*\\.[A-Za-z0-9]+$).+)"],
};
