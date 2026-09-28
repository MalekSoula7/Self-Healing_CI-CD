// The GitHub App client (SPEC §5.2): authenticates as the App with a JWT signed by its private
// key, and as each installation with an installation token. octokit creates those tokens on
// demand and caches them in memory until shortly before they expire; they are never stored.
import { App } from "octokit";
import { z } from "zod";
import {
  octokitOptions,
  pipehealOctokit,
  rateLimitState,
  type GitHubClientOptions,
  type RateLimitState,
} from "./client";
import { GuardError } from "./guards";
import { repoClient } from "./repo";

export interface GitHubAppConfig extends GitHubClientOptions {
  appId: number;
  /** PEM text (decodePrivateKey turns the env's base64 into this). */
  privateKey: string;
  /** Time limit for each request, each page and retry separately. Default 30 s. */
  requestTimeoutMs?: number;
  /** Told the installation's remaining quota after each response (the worker paces with it). */
  onRateLimit?: (installationId: bigint, state: RateLimitState) => void;
}

const installedRepositorySchema = z.object({
  id: z.number().int().positive().transform(BigInt),
  full_name: z.string(),
  default_branch: z.string(),
  archived: z.boolean().optional(),
});

// 100 pages of 100: the most repositories one installation is synced with.
const MAX_PAGES = 100;

export function createGitHubApp(config: GitHubAppConfig) {
  const Octokit = pipehealOctokit(config.requestTimeoutMs ?? 30_000).defaults(
    octokitOptions(config),
  );
  const app = new App({ appId: config.appId, privateKey: config.privateKey, Octokit });

  return {
    /** A client acting as one installation of the App. */
    async installation(installationId: bigint) {
      const octokit = await app.getInstallationOctokit(Number(installationId));
      const { onRateLimit } = config;
      if (onRateLimit !== undefined) {
        octokit.hook.after("request", (response) => {
          const state = rateLimitState(response.headers);
          if (state !== null) onRateLimit(installationId, state);
        });
      }
      return {
        /** Repositories the installation can access (P1.6 sync). */
        async listRepositories() {
          let pages = 0;
          const repositories: unknown[] = await octokit.paginate(
            "GET /installation/repositories",
            { per_page: 100 },
            (response, done) => {
              if (++pages > MAX_PAGES) done();
              return response.data;
            },
          );
          if (pages > MAX_PAGES) {
            throw new GuardError("the installation lists too many repositories");
          }
          return z
            .array(installedRepositorySchema)
            .parse(repositories)
            .map((repo) => ({
              githubRepoId: repo.id,
              fullName: repo.full_name,
              defaultBranch: repo.default_branch,
              archived: repo.archived ?? false,
            }));
        },
        repo: (fullName: string) => repoClient(octokit, fullName),
      };
    },
  };
}

export type GitHubApp = ReturnType<typeof createGitHubApp>;
export type InstallationClient = Awaited<ReturnType<GitHubApp["installation"]>>;
