// `.pipeheal.yml` on the default branch (SPEC §8.1, P3.7): a tightening layer anyone who can push
// may edit, so untrusted. Read as plain YAML data (core schema: no custom tags; few aliases, so no
// alias bomb; unique keys), validated with packages/policy's layer schema, and stored on the
// repository with the commit it was read at. Problems are stored as short messages for the UI and
// never thrown: a broken file leaves the repo without that layer, it never stops the pipeline.
// The App doesn't receive push events, so the file is re-read when the worker visits the repo
// (workflow sync, each failure) and the default branch has moved since the last read.
import { forSystem, MAX_POLICY_FILE_ERRORS, type Db, type Repository } from "@pipeheal/db";
import type { GitHubApp, RepoClient } from "@pipeheal/github";
import { policyLayerSchema, type PolicyLayer } from "@pipeheal/policy";
import type { Logger } from "@pipeheal/shared/logger";
import { parseDocument } from "yaml";
import type { FailureTarget } from "./triage";

export const POLICY_FILE_PATH = ".pipeheal.yml";
export const MAX_POLICY_FILE_BYTES = 64 * 1024;
const MAX_ALIASES = 20;
const MAX_ERROR_CHARS = 300;

export interface PolicyFileRead {
  layer: PolicyLayer | null;
  errors: string[] | null;
}

function cap(message: string): string {
  const line = message.replace(/\s+/g, " ").trim();
  return line.length <= MAX_ERROR_CHARS ? line : `${line.slice(0, MAX_ERROR_CHARS - 3)}...`;
}

function failed(errors: string[]): PolicyFileRead {
  return { layer: null, errors: errors.slice(0, MAX_POLICY_FILE_ERRORS).map(cap) };
}

/** The file's layer, or why it can't be used. Never throws. */
export function readPolicyFile(text: string): PolicyFileRead {
  if (Buffer.byteLength(text, "utf8") > MAX_POLICY_FILE_BYTES) {
    return failed([
      `${POLICY_FILE_PATH} is too large (at most ${String(MAX_POLICY_FILE_BYTES)} bytes)`,
    ]);
  }
  let value: unknown;
  try {
    const document = parseDocument(text, { schema: "core", uniqueKeys: true, prettyErrors: false });
    if (document.errors.length > 0) {
      return failed(document.errors.map((error) => `YAML: ${error.message}`));
    }
    value = document.toJS({ maxAliasCount: MAX_ALIASES });
  } catch (error) {
    return failed([`YAML: ${error instanceof Error ? error.message : "unreadable"}`]);
  }
  // An empty file (or only comments) is an empty layer.
  const parsed = policyLayerSchema.safeParse(value ?? {});
  if (!parsed.success) {
    return failed(
      parsed.error.issues.map((issue) => {
        const path = issue.path.map(String).join(".");
        return path === "" ? issue.message : `${path}: ${issue.message}`;
      }),
    );
  }
  return { layer: parsed.data, errors: null };
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
  repoClient: RepoClient,
  repo: RepoRow,
  db: Db,
  log: Logger,
): Promise<void> {
  const commitSha = await repoClient.getBranchSha(repo.defaultBranch);
  if (commitSha === null || commitSha === repo.policyFileCommitSha) return;
  const file = await repoClient.getFileAtRef(POLICY_FILE_PATH, commitSha, MAX_POLICY_FILE_BYTES);
  const read: PolicyFileRead =
    file === null
      ? { layer: null, errors: null }
      : file.kind === "text"
        ? readPolicyFile(file.content)
        : file.kind === "too_large"
          ? failed([
              `${POLICY_FILE_PATH} is too large (at most ${String(MAX_POLICY_FILE_BYTES)} bytes)`,
            ])
          : failed([`${POLICY_FILE_PATH} must be a regular text file (found: ${file.kind})`]);
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
  if (repo === null) return;
  const client = (await deps.githubApp.installation(target.installationId)).repo(repo.fullName);
  await refreshPolicyFile(client, repo, deps.db, log);
}
