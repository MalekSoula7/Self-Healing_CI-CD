// One octokit configuration for every GitHub call PipeHeal makes: our user agent, bounded retries
// and time, sanitized errors, and messages routed to our (redacting) logger.
import { Octokit } from "octokit";

export const USER_AGENT = "pipeheal";

export interface GitHubLog {
  debug: (message: string) => unknown;
  info: (message: string) => unknown;
  warn: (message: string) => unknown;
  error: (message: string) => unknown;
}

export interface GitHubClientOptions {
  /** API root; tests and GitHub Enterprise Server override it. */
  baseUrl?: string;
  /** Retries after 5xx for idempotent requests (octokit's retry plugin). Default 3. */
  retries?: number;
  /** Base delay between retries in ms (octokit's default: 1000). Tests shorten it. */
  retryAfterMs?: number;
  /** Where octokit reports retries. Defaults to silence. */
  log?: GitHubLog;
}

const silent: GitHubLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * A failed GitHub call, stripped of everything but what identifies it. octokit's RequestError
 * carries the request body (customer code, PR text), headers and URLs (a storage redirect is a
 * signed URL); none of that may reach logs, job records or other tenants.
 */
export class GitHubApiError extends Error {
  override readonly name = "GitHubApiError";

  constructor(
    readonly status: number,
    /** Method and URL template, e.g. "GET /repos/{owner}/{repo}/contents/{path}". */
    readonly route: string,
    /** GitHub's x-github-request-id, for support requests. */
    readonly requestId: string | null,
    githubMessage: string | null,
  ) {
    super(
      `GitHub answered ${String(status)} to ${route}${githubMessage === null ? "" : `: ${githubMessage}`}`,
    );
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

export function toGitHubApiError(error: unknown, method: string, url: string): GitHubApiError {
  const status = field(error, "status");
  const response = field(error, "response");
  const requestId = field(field(response, "headers"), "x-github-request-id");
  const message = field(field(response, "data"), "message");
  return new GitHubApiError(
    typeof status === "number" ? status : 500,
    `${method} ${url}`,
    typeof requestId === "string" ? requestId : null,
    // GitHub's own short explanation ("Reference already exists"), never the request.
    typeof message === "string" ? message.slice(0, 200) : null,
  );
}

/**
 * Octokit with our plugins:
 * - a time limit per request (a caller's own signal wins; retries share the limit);
 * - errors turned into GitHubApiError after octokit's own retries.
 *
 * octokit's throttling plugin is off: its queues are process-wide (one queue for every tenant)
 * and its rate-limit waits aren't bounded by our time limits. Pacing belongs to the worker's
 * per-installation queues, and rate-limited calls fail fast with their status.
 */
export function pipehealOctokit(requestTimeoutMs?: number): typeof Octokit {
  return Octokit.plugin((octokit) => {
    // `before`, not `wrap`: outer wraps can't replace the options inner layers receive.
    octokit.hook.before("request", (options) => {
      if (requestTimeoutMs !== undefined && options.request.signal === undefined) {
        options.request = { ...options.request, signal: AbortSignal.timeout(requestTimeoutMs) };
      }
    });
    octokit.hook.error("request", (error, options) => {
      throw toGitHubApiError(error, options.method, options.url);
    });
  });
}

/** Octokit constructor options for `options` (shared by user and App clients). */
export function octokitOptions(options: GitHubClientOptions) {
  return {
    userAgent: USER_AGENT,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    retry: {
      retries: options.retries ?? 3,
      ...(options.retryAfterMs === undefined ? {} : { retryAfterBaseValue: options.retryAfterMs }),
    },
    throttle: { enabled: false },
    log: options.log ?? silent,
  };
}

/**
 * A client authenticated as a user (a GitHub App user access token from sign-in).
 * `timeoutMs` bounds the whole call, all pages included; an aborted request may still be
 * retried once its backoff elapses, and then fails at once.
 */
export function userOctokit(
  accessToken: string,
  options: GitHubClientOptions & { timeoutMs?: number } = {},
): Octokit {
  const UserOctokit = pipehealOctokit();
  return new UserOctokit({
    auth: accessToken,
    ...octokitOptions(options),
    ...(options.timeoutMs === undefined
      ? {}
      : { request: { signal: AbortSignal.timeout(options.timeoutMs) } }),
  });
}

/** Per-request option: never retry a request that isn't idempotent (dispatch, comment, PR). */
export const NO_RETRY = { request: { retries: 0 } } as const;
