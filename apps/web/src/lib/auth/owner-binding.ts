// OWNER binding at sign-in and post-install (SPEC §5.2, D10). The installation webhook's sender
// is only a candidate. They become OWNER once GitHub, asked with their own user token, confirms
// that they can access the installation and that they own the account: it is their personal
// account, or they are an admin of the organization (installing alone isn't enough: a repository
// admin can install the App on an org's repositories).
import { githubIdentity, installations, type Db } from "@pipeheal/db";
import { listUserAdminOrgIds, listUserInstallationIds } from "@pipeheal/github";
import type { Logger } from "@pipeheal/shared/logger";
import type { Auth } from "./server";

export interface OwnerBindingDeps {
  db: Db;
  /** The user's GitHub token for this Better Auth account row, decrypted (and refreshed). */
  getAccessToken: (accountRowId: string) => Promise<string>;
  /** `GET /user/installations` with that token. */
  listInstallationIds: (accessToken: string) => Promise<bigint[]>;
  /** `GET /user/memberships/orgs` with that token: orgs where the user is an active admin. */
  listAdminOrgIds: (accessToken: string) => Promise<bigint[]>;
}

/** Binds every verified ownership. Returns the org IDs bound; GitHub isn't called without a candidate. */
export async function bindVerifiedOwnerships(
  deps: OwnerBindingDeps,
  userId: string,
): Promise<string[]> {
  const identity = await githubIdentity(deps.db, userId);
  if (identity === null) return [];
  const installs = installations(deps.db, "sign-in");
  const claim = { userId, githubUserId: identity.githubUserId };
  const candidates = await installs.ownerCandidates(claim);
  if (candidates.length === 0) return [];
  const accessToken = await deps.getAccessToken(identity.accountRowId);
  const installationIds = await deps.listInstallationIds(accessToken);
  const adminOrgIds = candidates.some((candidate) => candidate.accountType === "ORG")
    ? await deps.listAdminOrgIds(accessToken)
    : [];
  return installs.bindVerifiedOwner(claim, { installationIds, adminOrgIds });
}

/**
 * Wires `bindVerifiedOwnerships` to Better Auth and GitHub for a request, and logs rather than
 * throws: a GitHub failure here must never block sign-in or onboarding. Called at `/auth/complete`
 * (every sign-in) and `/onboarding/installed` (right after installing), so a newly bound OWNER
 * doesn't have to sign in again to be recognized.
 */
export async function runOwnerBindingCheck(
  db: Db,
  auth: Auth,
  headers: Headers,
  userId: string,
  logger: Logger,
): Promise<string[]> {
  // Bounded: GitHub is on the sign-in and post-install paths, and a slow GitHub must not hang them.
  const github = { log: logger, retries: 1, timeoutMs: 5_000 };
  try {
    const bound = await bindVerifiedOwnerships(
      {
        db,
        getAccessToken: async (accountId) => {
          const { accessToken } = await auth.api.getAccessToken({ body: { accountId }, headers });
          return accessToken;
        },
        listInstallationIds: (accessToken) => listUserInstallationIds(accessToken, github),
        listAdminOrgIds: (accessToken) => listUserAdminOrgIds(accessToken, github),
      },
      userId,
    );
    if (bound.length > 0) logger.info({ userId, orgIds: bound }, "owner bound");
    return bound;
  } catch (error) {
    logger.warn({ err: error, userId }, "owner check failed");
    return [];
  }
}
