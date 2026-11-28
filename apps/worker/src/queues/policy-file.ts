// `.pipeheal.yml` on the default branch (SPEC §8.1, P3.7): a tightening layer anyone who can push
// may edit, so untrusted. Read with packages/policy's `parsePolicyYaml` (plain YAML data, the layer
// schema; the dashboard editors use the same reader), and stored on the
// repository with the commit it was read at. Problems are stored as short messages for the UI and
// never thrown: a broken file leaves the repo without that layer, it never stops the pipeline.
// The App doesn't receive push events, so the file is re-read when the worker visits the repo
// (workflow sync, each failure) and the default branch has moved since the last read.
import { forSystem, type Db, type Repository } from "@pipeheal/db";
import type { GitHubApp, ReadOnlyRepoClient } from "@pipeheal/github";
import { MAX_POLICY_YAML_BYTES, parsePolicyYaml, type PolicyLayer } from "@pipeheal/policy";
import type { Logger } from "@pipeheal/shared/logger";
import type { FailureTarget } from "./triage";

export const POLICY_FILE_PATH = ".pipeheal.yml";
export interface PolicyFileRead {
  layer: PolicyLayer | null;
  errors: string[] | null;
}

function tooLarge(): PolicyFileRead {
  return {
    layer: null,
    errors: [`${POLICY_FILE_PATH} is too large (at most ${String(MAX_POLICY_YAML_BYTES)} bytes)`],
  };
}

export interface PolicyFileDeps {
  db: Db;
  githubApp: GitHubApp | null;
}

type RepoRow = Pick<Repository, "id" | "orgId" | "defaultBranch" | "policyFileCommitSha">;

/**
 * Reads `.pipeheal.yml` at the default branch's tip and stores it, unless that commit was the
 * last one read. GitHub errors propagate (the job retries); file problems are stored.
 */
export async function refreshPolicyFile(
  repoClient: ReadOnlyRepoClient,
  repo: RepoRow,
  db: Db,
  log: Logger,
): Promise<void> {
  const commitSha = await repoClient.getBranchSha(repo.defaultBranch);
  if (commitSha === null || commitSha === repo.policyFileCommitSha) return;
  const file = await repoClient.getFileAtRef(POLICY_FILE_PATH, commitSha, MAX_POLICY_YAML_BYTES);
  const read: PolicyFileRead =
    file === null
      ? { layer: null, errors: null }
      : file.kind === "text"
        ? parsePolicyYaml(file.content)
        : file.kind === "too_large"
          ? tooLarge()
          : {
              layer: null,
              errors: [`${POLICY_FILE_PATH} must be a regular text file (found: ${file.kind})`],
            };
  const system = await forSystem(db, repo.orgId, "policy-file");
  await system.repositories.recordPolicyFile(repo.id, { commitSha, ...read });
  // IDs and counts only: the file is repository content.
  log.info(
    {
      repoId: repo.id,
      commitSha,
      status: read.layer !== null ? "loaded" : read.errors !== null ? "invalid" : "absent",
    },
    "policy file read",
  );
}

/** The `policy-file` job: refreshes the failing repository's `.pipeheal.yml`. */
export async function refreshFailurePolicyFile(
  deps: PolicyFileDeps,
  target: FailureTarget,
  log: Logger,
): Promise<void> {
  if (deps.githubApp === null) {
    log.warn("GitHub App isn't configured; skipping the policy file");
    return;
  }
  const system = await forSystem(deps.db, target.orgId, "policy-file");
  const failure = await system.failures.get(target.failureId);
  if (failure === null) return;
  const repo = await system.repositories.get(failure.repoId);
  // A repository the installation no longer covers can't get a token: nothing to read.
  if (repo?.removedFromInstallationAt !== null) return;
  const client = await deps.githubApp.readOnlyRepo(target.installationId, repo);
  await refreshPolicyFile(client, repo, deps.db, log);
}
