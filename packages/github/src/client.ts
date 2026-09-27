// One octokit configuration for every GitHub call PipeHeal makes: our user agent, bounded retries
// and time, and rate-limit messages routed to our (redacting) logger instead of the console.
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
  /** Retries after 5xx and rate limits (octokit's retry plugin). Default 3. */
  retries?: number;
  /** Base delay between retries in ms (octokit's default: 1000). Tests shorten it. */
  retryAfterMs?: number;
  /** Where octokit reports rate limiting and retries. Defaults to silence. */
  log?: GitHubLog;
  /**
   * octokit paces writes (about one per second) and waits out rate limits, as GitHub asks of
   * integrations. On by default; tests turn it off.
   */
  pacing?: boolean;
}

const silent: GitHubLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Octokit constructor options for `options` (shared by user and App clients). */
export function octokitOptions(options: GitHubClientOptions) {
  return {
    userAgent: USER_AGENT,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    retry: {
      retries: options.retries ?? 3,
      ...(options.retryAfterMs === undefined ? {} : { retryAfterBaseValue: options.retryAfterMs }),
    },
    log: options.log ?? silent,
    ...(options.pacing === false ? { throttle: { enabled: false } } : {}),
  };
}

/**
 * Octokit with a time limit on every request (each page separately; a request's retries share
 * its limit, and octokit retries an aborted request once its backoff elapses). Long-lived App
 * clients can't use one signal for their whole life. A caller's own signal wins.
 */
export function timeLimitedOctokit(requestTimeoutMs: number): typeof Octokit {
  return Octokit.plugin((octokit) => {
    // A `before` hook, not `wrap`: outer wraps can't replace the options inner layers receive.
    octokit.hook.before("request", (options) => {
      if (options.request.signal === undefined) {
        options.request = { ...options.request, signal: AbortSignal.timeout(requestTimeoutMs) };
      }
    });
  });
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
  return new Octokit({
    auth: accessToken,
    ...octokitOptions(options),
    ...(options.timeoutMs === undefined
      ? {}
      : { request: { signal: AbortSignal.timeout(options.timeoutMs) } }),
  });
}
