// Calls made with a user's GitHub App user access token (from sign-in), never the App's own
// credentials. Responses are validated with zod before anything uses them.
import { Octokit } from "octokit";
import { z } from "zod";

export interface GitHubClientOptions {
  /** API root; tests and GitHub Enterprise Server override it. */
  baseUrl?: string;
  /** Retries after 5xx and rate limits (octokit's retry plugin). Default 3. */
  retries?: number;
  /** Aborts the whole call (all pages and retries) after this many milliseconds. */
  timeoutMs?: number;
  /** Where octokit reports rate limiting and retries. Defaults to silence. */
  log?: {
    debug: (message: string) => unknown;
    info: (message: string) => unknown;
    warn: (message: string) => unknown;
    error: (message: string) => unknown;
  };
}

export const USER_AGENT = "pipeheal";

const silent = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function userClient(accessToken: string, options: GitHubClientOptions): Octokit {
  return new Octokit({
    auth: accessToken,
    userAgent: USER_AGENT,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    retry: { retries: options.retries ?? 3 },
    ...(options.timeoutMs === undefined
      ? {}
      : { request: { signal: AbortSignal.timeout(options.timeoutMs) } }),
    log: options.log ?? silent,
  });
}

const userInstallationSchema = z.object({ id: z.number().int().positive() });

/**
 * IDs of the App installations the user can access (`GET /user/installations`, all pages).
 * Used for the OWNER check at sign-in (SPEC §5.2).
 */
export async function listUserInstallationIds(
  accessToken: string,
  options: GitHubClientOptions = {},
): Promise<bigint[]> {
  const installations: unknown = await userClient(accessToken, options).paginate(
    "GET /user/installations",
    { per_page: 100 },
  );
  return z
    .array(userInstallationSchema)
    .parse(installations)
    .map((installation) => BigInt(installation.id));
}
