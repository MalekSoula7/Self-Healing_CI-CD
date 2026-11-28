// Authorization decisions for signed-in users, free of Next.js so they can be tested against a
// real database. The Next.js wrappers are in ./session.ts.
import { forMember, hasRole, type Db, type OrgScope, type Role } from "@pipeheal/db";

/**
 * The user's scope in the organization, or null when the organization doesn't exist, the user
 * isn't a member, or their role is below `minimum`. Callers answer 404 for all three.
 */
export async function resolveOrgAccess(
  db: Db,
  userId: string,
  orgSlug: string,
  minimum: Role = "MEMBER",
): Promise<OrgScope | null> {
  const scope = await forMember(db, { orgSlug, userId });
  if (scope === null || !hasRole(scope.role, minimum)) return null;
  return scope;
}
