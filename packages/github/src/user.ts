// Calls made with a user's GitHub App user access token (from sign-in), never the App's own
// credentials. Responses are validated with zod before anything uses them.
import { z } from "zod";
import { userOctokit, type GitHubClientOptions } from "./client";

const userInstallationSchema = z.object({ id: z.number().int().positive() });

/**
 * IDs of the App installations the user can access (`GET /user/installations`, all pages).
 * Used for the OWNER check at sign-in (SPEC §5.2).
 */
export async function listUserInstallationIds(
  accessToken: string,
  options: GitHubClientOptions & { timeoutMs?: number } = {},
): Promise<bigint[]> {
  const installations: unknown = await userOctokit(accessToken, options).paginate(
    "GET /user/installations",
    { per_page: 100 },
  );
  return z
    .array(userInstallationSchema)
    .parse(installations)
    .map((installation) => BigInt(installation.id));
}
