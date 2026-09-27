// Session and org guards for server components, route handlers and server actions. The proxy
// only checks that a session cookie exists; these check the session and the membership, and
// must be called by every org layout, page, route handler and server action (SPEC §5.2).
import "server-only";
import type { OrgScope, Role } from "@pipeheal/db";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "@/lib/db";
import { resolveOrgAccess } from "./access";
import { getAuth } from "./server";

export interface SessionUser {
  id: string;
  name: string;
  login?: string | null | undefined;
  image?: string | null | undefined;
}

/** The signed-in user, or null. One session lookup per request. */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  // Reading the request first makes every caller dynamic: nothing reads the environment (or its
  // secrets) while pages are prerendered at build time.
  const requestHeaders = await headers();
  const auth = getAuth();
  if (auth === null) return null;
  const session = await auth.api.getSession({ headers: requestHeaders });
  return session?.user ?? null;
});

/** The signed-in user; signed-out visitors are sent to /login and come back to `returnTo`. */
export async function requireUser(returnTo: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (user === null) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  return user;
}

/**
 * The signed-in user's scope in `/[org]`. Signed-out: redirect to /login. Not a member, or
 * role below `minimum`: 404, so outsiders can't even tell the organization exists.
 */
export const requireOrgMember = cache(
  async (orgSlug: string, minimum: Role = "MEMBER"): Promise<OrgScope> => {
    const user = await requireUser(`/${orgSlug}`);
    const scope = await resolveOrgAccess(getDb(), user.id, orgSlug, minimum);
    if (scope === null) notFound();
    return scope;
  },
);
