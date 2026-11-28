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
import { webhookDeliveries } from "./deliveries";
import { GuardError } from "./guards";
import { repoClient, type RepoClient } from "./repo";

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
    /** The App webhook's deliveries, for redelivering failed ones (SPEC §2.2). */
    webhookDeliveries: webhookDeliveries(app.octokit),

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

    /**
     * A read-only client for one repository, for reads whose results feed a model (job logs,
     * diffs, file contents): its installation token covers only this repository, with only
     * `contents: read` and `actions: read` (P1.4 review L9). A prompt injection that steered a
     * read can't reach another repository or write anything, and the type offers only reads.
     */
    async readOnlyRepo(
      installationId: bigint,
      repo: { githubRepoId: bigint; fullName: string },
    ): Promise<ReadOnlyRepoClient> {
      const installation = safeId(installationId, "installation");
      const repository = safeId(repo.githubRepoId, "repository");
      /** A token for this scope, checked: GitHub must have applied the scope we asked for. */
      async function scopedToken(): Promise<string> {
        const auth = installationTokenSchema.safeParse(
          await app.octokit.auth({
            type: "installation",
            installationId: installation,
            repositoryIds: [repository],
            permissions: READ_ONLY_PERMISSIONS,
          }),
        );
        if (
          !auth.success ||
          (auth.data.repositoryIds !== undefined &&
            (auth.data.repositoryIds.length !== 1 || auth.data.repositoryIds[0] !== repository))
        ) {
          throw new GuardError("GitHub didn't scope the installation token as asked");
        }
        return auth.data.token;
      }
      await scopedToken();
      const octokit = new Octokit();
      // Every request asks for the token again: auth-app caches it per scope until shortly before
      // it expires, so a client held for a while never sends an expired one.
      octokit.hook.before("request", async (options) => {
        options.headers.authorization = `token ${await scopedToken()}`;
      });
      const { onRateLimit } = config;
      if (onRateLimit !== undefined) {
        octokit.hook.after("request", (response) => {
          const state = rateLimitState(response.headers);
          if (state !== null) onRateLimit(installationId, state);
        });
      }
      const client = repoClient(octokit, repo.fullName);
      // Bound: the client's methods call each other through `this`.
      return {
        listRunsForSha: client.listRunsForSha.bind(client),
        listSuccessfulRuns: client.listSuccessfulRuns.bind(client),
        listJobs: client.listJobs.bind(client),
        listFailedJobs: client.listFailedJobs.bind(client),
        downloadJobLog: client.downloadJobLog.bind(client),
        compareCommits: client.compareCommits.bind(client),
        getFileAtRef: client.getFileAtRef.bind(client),
        getBranchSha: client.getBranchSha.bind(client),
        listWorkflows: client.listWorkflows.bind(client),
      };
    },
  };
}

/** What a read-only token may do: read code and Actions data, nothing else (metadata is implied). */
export const READ_ONLY_PERMISSIONS = { contents: "read", actions: "read" } as const;

/** auth-app's answer for an installation token: only the requested repository, only reads. */
const installationTokenSchema = z.object({
  token: z.string().min(1),
  repositorySelection: z.literal("selected"),
  permissions: z
    .record(z.string(), z.string())
    .refine(
      (permissions) =>
        Object.entries(permissions).every(
          ([name, level]) =>
            level === "read" && (name === "contents" || name === "actions" || name === "metadata"),
        ),
      "the token has more than read access",
    ),
  repositoryIds: z.array(z.number()).optional(),
});

/** A GitHub ID as the number octokit wants, refusing one that wouldn't survive the conversion. */
function safeId(id: bigint, kind: string): number {
  const value = Number(id);
  if (!Number.isSafeInteger(value) || value <= 0) throw new GuardError(`invalid ${kind} ID`);
  return value;
}

/** The reads of `RepoClient`: no method that writes. */
export type ReadOnlyRepoClient = Pick<
  RepoClient,
  | "listRunsForSha"
  | "listSuccessfulRuns"
  | "listJobs"
  | "listFailedJobs"
  | "downloadJobLog"
  | "compareCommits"
  | "getFileAtRef"
  | "getBranchSha"
  | "listWorkflows"
>;

export type GitHubApp = ReturnType<typeof createGitHubApp>;
export type InstallationClient = Awaited<ReturnType<GitHubApp["installation"]>>;
