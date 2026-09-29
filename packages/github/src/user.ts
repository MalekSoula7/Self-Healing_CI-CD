// Calls made with a user's GitHub App user access token (from sign-in), never the App's own
// credentials. Responses are validated with zod before anything uses them.
import { z } from "zod";
import { userOctokit, type GitHubClientOptions } from "./client";
import { GuardError } from "./guards";

type UserCallOptions = GitHubClientOptions & { timeoutMs?: number };

const userInstallationSchema = z.object({ id: z.number().int().positive() });
const orgMembershipSchema = z.object({
  state: z.string(),
  role: z.string(),
  organization: z.object({ id: z.number().int().positive() }),
});

// A user's installations or organizations fit in a few pages; more is a runaway listing.
const MAX_PAGES = 20;

function capped<T>() {
  let pages = 0;
  const mapPage = (response: { data: T[] }, done: () => void): T[] => {
    pages += 1;
    if (pages > MAX_PAGES) done();
    return response.data;
  };
  const check = () => {
    if (pages > MAX_PAGES) throw new GuardError("the listing is longer than expected");
  };
  return { mapPage, check };
}

/**
 * IDs of the App installations the user can access (`GET /user/installations`, all pages).
 * Part of the OWNER check at sign-in (SPEC §5.2).
 */
export async function listUserInstallationIds(
  accessToken: string,
  options: UserCallOptions = {},
): Promise<bigint[]> {
  const pages = capped();
  const installations: unknown[] = await userOctokit(accessToken, options).paginate(
    "GET /user/installations",
    { per_page: 100 },
    pages.mapPage,
  );
  pages.check();
  return z
    .array(userInstallationSchema)
    .parse(installations)
    .map((installation) => BigInt(installation.id));
}

/**
 * IDs of the organizations where the user is an active admin, i.e. an org owner
 * (`GET /user/memberships/orgs`; needs the App's Members: read permission, D10). Matched on
 * organization ID, so a renamed organization still matches. Part of the OWNER check.
 */
export async function listUserAdminOrgIds(
  accessToken: string,
  options: UserCallOptions = {},
): Promise<bigint[]> {
  const pages = capped();
  const memberships: unknown[] = await userOctokit(accessToken, options).paginate(
    "GET /user/memberships/orgs",
    { state: "active", per_page: 100 },
    pages.mapPage,
  );
  pages.check();
  return z
    .array(orgMembershipSchema)
    .parse(memberships)
    .filter((membership) => membership.state === "active" && membership.role === "admin")
    .map((membership) => BigInt(membership.organization.id));
}
