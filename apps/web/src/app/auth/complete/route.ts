// Where GitHub sign-in lands (Better Auth's callbackURL): binds verified ownerships, then
// continues to the page the user came from. Safe to call again: it only binds what GitHub confirms.
import { NextResponse, type NextRequest } from "next/server";
import { webEnv } from "@/env";
import { runOwnerBindingCheck } from "@/lib/auth/owner-binding";
import { getAuth } from "@/lib/auth/server";
import { getDb } from "@/lib/db";
import { getLogger } from "@/lib/logger";
import { safeNextPath } from "@/lib/safe-redirect";

export async function GET(request: NextRequest): Promise<Response> {
  const { APP_URL } = webEnv();
  const next = safeNextPath(request.nextUrl.searchParams.get("next"));
  const auth = getAuth();
  const session = auth === null ? null : await auth.api.getSession({ headers: request.headers });
  if (auth === null || session === null) {
    return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(next)}`, APP_URL));
  }

  const logger = getLogger().child({ component: "owner-binding" });
  await runOwnerBindingCheck(getDb(), auth, request.headers, session.user.id, logger);
  return NextResponse.redirect(sameOrigin(next, APP_URL));
}

/** `path` resolved against the app's URL; the app's root if it would leave the site. */
export function sameOrigin(path: string, appUrl: string): URL {
  const target = new URL(path, appUrl);
  return target.origin === new URL(appUrl).origin ? target : new URL("/", appUrl);
}
