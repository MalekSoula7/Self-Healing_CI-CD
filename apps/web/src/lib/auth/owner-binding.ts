// OWNER binding at sign-in (SPEC §5.2). The installation webhook's sender is only a candidate;
// they become OWNER once GitHub, asked with their own user token, lists that installation.
import { githubIdentity, installations, type Db } from "@pipeheal/db";

export interface OwnerBindingDeps {
  db: Db;
  /** The user's GitHub token for this Better Auth account row, decrypted (and refreshed). */
  getAccessToken: (accountRowId: string) => Promise<string>;
  /** `GET /user/installations` with that token. */
  listInstallationIds: (accessToken: string) => Promise<bigint[]>;
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
  const accessible = await deps.listInstallationIds(accessToken);
  return installs.bindVerifiedOwner(claim, accessible);
}
