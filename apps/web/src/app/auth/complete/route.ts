// Where GitHub sign-in lands (Better Auth's callbackURL): binds verified ownerships, then
// continues to the page the user came from. Safe to call again: it only binds what GitHub confirms.
import { listUserAdminOrgIds, listUserInstallationIds } from "@pipeheal/github";
import { NextResponse, type NextRequest } from "next/server";
import { webEnv } from "@/env";
import { bindVerifiedOwnerships } from "@/lib/auth/owner-binding";
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
  // Bounded: GitHub is on the sign-in path, and a slow GitHub must not hang it.
  const github = { log: logger, retries: 1, timeoutMs: 5_000 };
  try {
    const bound = await bindVerifiedOwnerships(
      {
        db: getDb(),
        getAccessToken: async (accountId) => {
          const { accessToken } = await auth.api.getAccessToken({
            body: { accountId },
            headers: request.headers,
          });
          return accessToken;
        },
        listInstallationIds: (accessToken) => listUserInstallationIds(accessToken, github),
        listAdminOrgIds: (accessToken) => listUserAdminOrgIds(accessToken, github),
      },
      session.user.id,
    );
    if (bound.length > 0) logger.info({ userId: session.user.id, orgIds: bound }, "owner bound");
  } catch (error) {
    // Sign-in still succeeds; the check runs again at the next sign-in.
    logger.warn({ err: error, userId: session.user.id }, "owner check failed");
  }
  return NextResponse.redirect(sameOrigin(next, APP_URL));
}

/** `path` resolved against the app's URL; the app's root if it would leave the site. */
function sameOrigin(path: string, appUrl: string): URL {
  const target = new URL(path, appUrl);
  return target.origin === new URL(appUrl).origin ? target : new URL("/", appUrl);
}
