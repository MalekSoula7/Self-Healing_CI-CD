// Reads about a signed-in user that aren't org-scoped.
import type { Db } from "./client";
import { githubIdSchema } from "./inputs";

export const GITHUB_PROVIDER_ID = "github";

export interface GitHubIdentity {
  /** Better Auth's Account row ID (what its token endpoints take). */
  accountRowId: string;
  /** The user's numeric GitHub ID (Account.accountId). */
  githubUserId: bigint;
}

/** The user's GitHub account link, without its tokens. Null when there is none. */
export async function githubIdentity(db: Db, userId: string): Promise<GitHubIdentity | null> {
  const account = await db.account.findFirst({
    where: { userId, providerId: GITHUB_PROVIDER_ID },
    select: { id: true, accountId: true },
  });
  if (account === null || !/^\d+$/.test(account.accountId)) return null;
  const githubUserId = githubIdSchema.safeParse(BigInt(account.accountId));
  return githubUserId.success
    ? { accountRowId: account.id, githubUserId: githubUserId.data }
    : null;
}
