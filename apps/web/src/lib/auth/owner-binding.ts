// OWNER binding at sign-in (SPEC §5.2, D10). The installation webhook's sender is only a
// candidate. They become OWNER once GitHub, asked with their own user token, confirms that they
// can access the installation and that they own the account: it is their personal account, or
// they are an admin of the organization (installing alone isn't enough: a repository admin can
// install the App on an org's repositories).
import { githubIdentity, installations, type Db } from "@pipeheal/db";

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
