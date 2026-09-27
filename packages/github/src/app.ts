// The GitHub App client (SPEC §5.2): authenticates as the App with a JWT signed by its private
// key, and as each installation with an installation token. octokit creates those tokens on
// demand and caches them in memory until shortly before they expire; they are never stored.
import { App } from "octokit";
import { z } from "zod";
import { octokitOptions, timeLimitedOctokit, type GitHubClientOptions } from "./client";
import { repoClient } from "./repo";

export interface GitHubAppConfig extends GitHubClientOptions {
  appId: number;
  /** PEM text (decodePrivateKey turns the env's base64 into this). */
  privateKey: string;
  /** Time limit for each request, each page and retry separately. Default 30 s. */
  requestTimeoutMs?: number;
}

const installedRepositorySchema = z.object({
  id: z.number().int().positive().transform(BigInt),
  full_name: z.string(),
  default_branch: z.string(),
  archived: z.boolean().optional(),
});

export function createGitHubApp(config: GitHubAppConfig) {
  const Octokit = timeLimitedOctokit(config.requestTimeoutMs ?? 30_000).defaults(
    octokitOptions(config),
  );
  const app = new App({ appId: config.appId, privateKey: config.privateKey, Octokit });

  return {
    /** A client acting as one installation of the App. */
    async installation(installationId: bigint) {
      const octokit = await app.getInstallationOctokit(Number(installationId));
      return {
        /** Repositories the installation can access (P1.6 sync). */
        async listRepositories() {
          const repositories: unknown = await octokit.paginate("GET /installation/repositories", {
            per_page: 100,
          });
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
