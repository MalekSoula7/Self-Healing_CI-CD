// Typed wrappers for the repository endpoints PipeHeal uses, on an installation's client.
// Every response is validated with zod and mapped to a small domain type; nothing downstream
// sees GitHub's raw JSON. Writes go through the guards in ./guards.ts. There is deliberately no
// merge wrapper: PipeHeal never merges (CLAUDE.md).
import type { Octokit } from "octokit";
import { z } from "zod";
import { GitHubApiError, NO_RETRY } from "./client";
import {
  GuardError,
  assertBranchName,
  assertCommitMessage,
  assertHealBranch,
  assertRepoPath,
  assertWritablePath,
  isHealBranch,
  parseFullName,
} from "./guards";

const id = z.number().int().positive().transform(BigInt);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const login = z.string().regex(/^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}(\[bot\])?$/);
const repoRef = z.object({ id: z.number().int().positive(), full_name: z.string() });

export const workflowRunSchema = z.object({
  id,
  run_attempt: z.number().int().positive(),
  workflow_id: id,
  name: z.string().nullable(),
  path: z.string(),
  head_sha: sha,
  head_branch: z.string().nullable(),
  event: z.string(),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  html_url: z.string(),
  repository: repoRef,
  head_repository: repoRef.nullable().optional(),
});

const jobSchema = z.object({
  id,
  run_id: id,
  run_attempt: z.number().int().positive(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  html_url: z.string().nullable(),
  steps: z
    .array(
      z.object({ name: z.string(), number: z.number().int(), conclusion: z.string().nullable() }),
    )
    .optional(),
});

const workflowSchema = z.object({ id, name: z.string(), path: z.string(), state: z.string() });

/** GitHub lists at most this many files in a comparison. */
export const COMPARE_FILE_LIMIT = 300;

const comparisonSchema = z.object({
  status: z.string(),
  ahead_by: z.number().int(),
  behind_by: z.number().int(),
  total_commits: z.number().int(),
  commits: z.array(
    z.object({
      sha,
      commit: z.object({ message: z.string() }),
      author: z.object({ login: z.string() }).nullable(),
    }),
  ),
  files: z
    .array(
      z.object({
        filename: z.string(),
        previous_filename: z.string().optional(),
        status: z.string(),
        additions: z.number().int(),
        deletions: z.number().int(),
        patch: z.string().optional(),
      }),
    )
    .optional(),
});

const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string(),
  state: z.string(),
  draft: z.boolean().optional(),
  merged: z.boolean().optional(),
  head: z.object({ ref: z.string(), sha, repo: repoRef.nullable() }),
  base: z.object({ ref: z.string(), repo: repoRef }),
});

const contentSchema = z.union([
  z.array(z.unknown()),
  z.object({
    type: z.enum(["file", "symlink", "submodule", "dir"]),
    path: z.string(),
    size: z.number().int().nonnegative(),
    encoding: z.string().optional(),
    content: z.string().optional(),
  }),
]);

const treeSchema = z.object({
  sha,
  truncated: z.boolean().optional(),
  tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha })),
});

export type WorkflowRun = ReturnType<typeof toWorkflowRun>;
export type Job = ReturnType<typeof toJob>;
export type Workflow = ReturnType<typeof toWorkflow>;
export type Comparison = ReturnType<typeof toComparison>;
export type PullRequest = ReturnType<typeof toPullRequest>;

export function toWorkflowRun(run: z.output<typeof workflowRunSchema>) {
  return {
    id: run.id,
    runAttempt: run.run_attempt,
    workflowId: run.workflow_id,
    name: run.name,
    path: run.path,
    headSha: run.head_sha,
    headBranch: run.head_branch,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    htmlUrl: run.html_url,
    /**
     * The code didn't come from this repository (a fork PR, or GitHub didn't say): PipeHeal
     * never acts on these (CLAUDE.md). Compared by repository ID, never by name.
     */
    fromFork: run.head_repository?.id !== run.repository.id,
  };
}

function toJob(job: z.output<typeof jobSchema>) {
  return {
    id: job.id,
    runId: job.run_id,
    runAttempt: job.run_attempt,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    htmlUrl: job.html_url,
    /** The first failed step, if GitHub reports one. */
    failedStep: job.steps?.find((step) => step.conclusion === "failure")?.name ?? null,
  };
}

function toWorkflow(workflow: z.output<typeof workflowSchema>) {
  return { id: workflow.id, name: workflow.name, path: workflow.path, state: workflow.state };
}

function toComparison(comparison: z.output<typeof comparisonSchema>) {
  const files = comparison.files ?? [];
  return {
    status: comparison.status,
    aheadBy: comparison.ahead_by,
    behindBy: comparison.behind_by,
    totalCommits: comparison.total_commits,
    commits: comparison.commits.map((commit) => ({
      sha: commit.sha,
      message: commit.commit.message,
      authorLogin: commit.author?.login ?? null,
    })),
    /** GitHub lists at most 250 commits. */
    commitsTruncated: comparison.total_commits > comparison.commits.length,
    files: files.map((file) => ({
      path: file.filename,
      previousPath: file.previous_filename ?? null,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      /** Absent for binary files and very large diffs. */
      patch: file.patch ?? null,
    })),
    /** GitHub lists at most 300 files: more may have changed. */
    filesTruncated: files.length >= COMPARE_FILE_LIMIT,
  };
}

function toPullRequest(pull: z.output<typeof pullRequestSchema>) {
  return {
    number: pull.number,
    htmlUrl: pull.html_url,
    state: pull.state,
    draft: pull.draft ?? false,
    merged: pull.merged ?? false,
    headRef: pull.head.ref,
    headSha: pull.head.sha,
    baseRef: pull.base.ref,
    /** From a fork (or a deleted head repo): PipeHeal never acts on these. Compared by ID. */
    fromFork: pull.head.repo?.id !== pull.base.repo.id,
  };
}

export type FileAtRef =
  | { kind: "text"; content: string; bytes: number }
  | { kind: "binary"; bytes: number }
  | { kind: "too_large"; bytes: number; maxBytes: number }
  | { kind: "symlink" }
  | { kind: "submodule" }
  | { kind: "not_a_file" };

export interface JobLog {
  /** The end of the log (errors are at the end), at most `maxBytes`, starting on a whole line. */
  text: string;
  truncated: boolean;
}

/** A file to write or delete. Its mode is kept from the parent commit (new files: 100644). */
export type FileChange = { path: string; content: string } | { path: string; delete: true };

const MAX_COMMENT_CHARS = 65_536;
/** GitHub's contents API returns file content inline up to this size. */
export const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LIST_ITEMS = 10_000;
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

// Hosts GitHub redirects log downloads to. Anything else is refused.
const LOG_STORAGE_HOST = /(^|\.)(actions\.githubusercontent\.com|blob\.core\.windows\.net)$/;

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decodes UTF-8 exactly (a BOM is kept), or null for bytes that aren't UTF-8 text. */
function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}

/** Reads a byte stream, keeping at most its last `maxBytes`. */
async function readTail(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    chunks.push(value);
    kept += value.byteLength;
    while (kept - (chunks[0]?.byteLength ?? 0) >= maxBytes) {
      kept -= chunks.shift()?.byteLength ?? 0;
    }
  }
  const joined = Buffer.concat(chunks);
  const bytes =
    joined.byteLength > maxBytes ? joined.subarray(joined.byteLength - maxBytes) : joined;
  return { bytes, truncated: total > bytes.byteLength };
}

function isNotFound(error: unknown): boolean {
  return error instanceof GitHubApiError && error.status === 404;
}

/** Stops a paginated listing past `max` items (a runaway listing is a bug, not data). */
function capped<T>(max: number) {
  let seen = 0;
  return (response: { data: T[] }, done: () => void): T[] => {
    seen += response.data.length;
    if (seen > max) done();
    return response.data;
  };
}

function assertWithinCap(items: readonly unknown[], max: number): void {
  if (items.length > max) throw new GuardError(`more than ${String(max)} results`);
}

/** A client for one repository of an installation. */
export function repoClient(octokit: Octokit, fullName: string) {
  const { owner, repo } = parseFullName(fullName);
  const where = { owner, repo };

  async function getRun(runId: bigint): Promise<WorkflowRun> {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}", {
      ...where,
      run_id: Number(runId),
    });
    return toWorkflowRun(workflowRunSchema.parse(data));
  }

  async function getPullRequest(number: number): Promise<PullRequest> {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      ...where,
      pull_number: number,
    });
    return toPullRequest(pullRequestSchema.parse(data));
  }

  /** A pull request PipeHeal may act on: not from a fork (CLAUDE.md). */
  async function ownPullRequest(number: number): Promise<PullRequest> {
    let pull;
    try {
      pull = await getPullRequest(number);
    } catch (error) {
      if (isNotFound(error)) throw new GuardError("PipeHeal only comments on pull requests");
      throw error;
    }
    if (pull.fromFork) throw new GuardError("PipeHeal never acts on pull requests from forks");
    return pull;
  }

  /** The tree entries along paths in `treeSha`; lists each directory once. */
  function treeWalker(treeSha: string) {
    const listings = new Map<string, Promise<z.output<typeof treeSchema>>>();
    const list = (sha: string) => {
      let listing = listings.get(sha);
      if (listing === undefined) {
        listing = octokit
          .request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", { ...where, tree_sha: sha })
          .then(({ data }) => treeSchema.parse(data));
        listings.set(sha, listing);
      }
      return listing;
    };
    /** The entry at `path`, null if absent. Refuses paths that go through a non-directory. */
    return async (path: string) => {
      const segments = path.split("/");
      let current = treeSha;
      for (const [index, segment] of segments.entries()) {
        const entry = (await list(current)).tree.find((candidate) => candidate.path === segment);
        if (entry === undefined) return null;
        if (index === segments.length - 1) return entry;
        if (entry.type !== "tree") {
          throw new GuardError("the path goes through something that isn't a directory");
        }
        current = entry.sha;
      }
      return null;
    };
  }

  return {
    fullName: `${owner}/${repo}`,

    /** Every workflow run for a commit (SPEC §2.1 collection window). */
    async listRunsForSha(headSha: string): Promise<WorkflowRun[]> {
      const runs: unknown[] = await octokit.paginate(
        "GET /repos/{owner}/{repo}/actions/runs",
        { ...where, head_sha: sha.parse(headSha), per_page: 100 },
        capped(MAX_LIST_ITEMS),
      );
      assertWithinCap(runs, MAX_LIST_ITEMS);
      return z.array(workflowRunSchema).parse(runs).map(toWorkflowRun);
    },

    getRun,

    /** The jobs of one attempt of a run. */
    async listJobs(runId: bigint, attempt: number): Promise<Job[]> {
      const jobs: unknown[] = await octokit.paginate(
        "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs",
        { ...where, run_id: Number(runId), attempt_number: attempt, per_page: 100 },
        capped(MAX_LIST_ITEMS),
      );
      assertWithinCap(jobs, MAX_LIST_ITEMS);
      return z.array(jobSchema).parse(jobs).map(toJob);
    },

    /** The jobs of one attempt that failed or timed out. */
    async listFailedJobs(runId: bigint, attempt: number): Promise<Job[]> {
      const jobs = await this.listJobs(runId, attempt);
      return jobs.filter((job) => job.conclusion === "failure" || job.conclusion === "timed_out");
    },

    /**
     * A job's log. GitHub redirects to a short-lived signed storage URL: we follow it ourselves,
     * only to GitHub's log storage, without our token, and stream it so a huge log never sits in
     * memory whole.
     */
    async downloadJobLog(jobId: bigint, maxBytes = 5 * 1024 * 1024): Promise<JobLog> {
      const response = await octokit.request(
        "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs",
        {
          ...where,
          job_id: Number(jobId),
          request: { redirect: "manual", parseSuccessResponseBody: false },
        },
      );
      const location = z.url().safeParse(response.headers.location);
      const storage = location.success ? new URL(location.data) : null;
      if (storage?.protocol !== "https:" || !LOG_STORAGE_HOST.test(storage.hostname)) {
        throw new GuardError("GitHub didn't redirect the log to its log storage");
      }
      const log = await fetch(storage, { signal: AbortSignal.timeout(60_000) });
      if (!log.ok || log.body === null) {
        // The signed URL stays out of the error.
        throw new GitHubApiError(log.status, "GET <log storage>", null, null);
      }
      const { bytes, truncated } = await readTail(log.body as ReadableStream<Uint8Array>, maxBytes);
      let text = new TextDecoder().decode(bytes);
      if (truncated) text = text.slice(text.indexOf("\n") + 1);
      return { text, truncated };
    },

    async compareCommits(base: string, head: string): Promise<Comparison> {
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
        ...where,
        basehead: `${sha.parse(base)}...${sha.parse(head)}`,
      });
      return toComparison(comparisonSchema.parse(data));
    },

    /**
     * What is at `path` in a commit: exact text (a BOM is kept), or what kind of entry it is.
     * Null when nothing is there. At most MAX_FILE_BYTES (GitHub's inline limit).
     */
    async getFileAtRef(
      path: string,
      ref: string,
      maxBytes = MAX_FILE_BYTES,
    ): Promise<FileAtRef | null> {
      assertRepoPath(path);
      const limit = Math.min(maxBytes, MAX_FILE_BYTES);
      let data;
      try {
        ({ data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
          ...where,
          path,
          ref: sha.parse(ref),
        }));
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
      const content = contentSchema.parse(data);
      if (Array.isArray(content) || content.type === "dir") return { kind: "not_a_file" };
      if (content.type === "submodule") return { kind: "submodule" };
      // For a symlink to a file, GitHub answers with the target's content: its path differs.
      if (content.type === "symlink" || content.path !== path) return { kind: "symlink" };
      if (content.size > limit) return { kind: "too_large", bytes: content.size, maxBytes: limit };
      if (content.encoding !== "base64" || content.content === undefined) {
        throw new GuardError("GitHub returned file content in an unexpected form");
      }
      const bytes = Buffer.from(content.content, "base64");
      const text = decodeText(bytes);
      return text === null
        ? { kind: "binary", bytes: bytes.byteLength }
        : { kind: "text", content: text, bytes: bytes.byteLength };
    },

    /**
     * The commit SHA a branch currently points at, or null if the branch doesn't exist. That
     * includes an empty repository (no commits yet), which GitHub answers with 409, not 404.
     */
    async getBranchSha(branch: string): Promise<string | null> {
      assertBranchName(branch);
      try {
        const { data } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
          ...where,
          ref: `heads/${branch}`,
        });
        return sha.parse(z.object({ object: z.object({ sha }) }).parse(data).object.sha);
      } catch (error) {
        if (isNotFound(error) || (error instanceof GitHubApiError && error.status === 409)) {
          return null;
        }
        throw error;
      }
    },

    async listWorkflows(): Promise<Workflow[]> {
      const workflows: unknown[] = await octokit.paginate(
        "GET /repos/{owner}/{repo}/actions/workflows",
        { ...where, per_page: 100 },
        capped(MAX_LIST_ITEMS),
      );
      assertWithinCap(workflows, MAX_LIST_ITEMS);
      return z.array(workflowSchema).parse(workflows).map(toWorkflow);
    },

    /** Re-runs the failed jobs of a run's latest attempt (flaky check, SPEC §6.2). Never forks. */
    async rerunFailedJobs(runId: bigint): Promise<void> {
      if ((await getRun(runId)).fromFork) {
        throw new GuardError("PipeHeal never re-runs code from forks");
      }
      await octokit.request("POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs", {
        ...where,
        run_id: Number(runId),
        ...NO_RETRY,
      });
    },

    /**
     * Dispatches a workflow on `ref` (the healer, SPEC §5.3). Returns the run ID when GitHub
     * reports it (for the OIDC run_id check, SPEC §5.4). Never retried: a retry could start a
     * second healer run.
     */
    async dispatchWorkflow(
      workflowPath: string,
      ref: string,
      inputs: Record<string, string>,
    ): Promise<{ runId: bigint | null }> {
      assertRepoPath(workflowPath);
      assertBranchName(ref);
      const file = /^\.github\/workflows\/([^/]+\.ya?ml)$/.exec(workflowPath)?.[1];
      if (file === undefined) throw new GuardError("not a workflow file path");
      const { data } = await octokit.request(
        "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
        { ...where, workflow_id: file, ref, inputs, return_run_details: true, ...NO_RETRY },
      );
      const details = z.object({ workflow_run_id: id }).safeParse(data);
      return { runId: details.success ? details.data.workflow_run_id : null };
    },

    /**
     * One commit on a `pipeheal/*` branch through the Git Data API (SPEC §9), on top of
     * `parentSha`. Creates the branch, or moves it forward from exactly `parentSha` (a branch
     * someone else moved is refused); never forces. Each path must be a regular file (or new):
     * symlinks, submodules and directories are refused, and file modes are kept.
     */
    async commitFiles(options: {
      branch: string;
      parentSha: string;
      message: string;
      changes: FileChange[];
      createBranch: boolean;
    }): Promise<{ commitSha: string }> {
      assertHealBranch(options.branch);
      assertCommitMessage(options.message);
      if (options.changes.length === 0) throw new GuardError("a commit needs at least one change");
      const paths = options.changes.map((change) => change.path);
      for (const path of paths) assertWritablePath(path);
      if (new Set(paths).size !== paths.length) throw new GuardError("a path appears twice");
      const parentSha = sha.parse(options.parentSha);

      if (!options.createBranch) {
        const { data: ref } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
          ...where,
          ref: `heads/${options.branch}`,
        });
        const tip = z.object({ object: z.object({ sha }) }).parse(ref).object.sha;
        if (tip !== parentSha) {
          throw new GuardError("the branch moved: PipeHeal only extends its own last commit");
        }
      }

      const { data: parent } = await octokit.request(
        "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
        { ...where, commit_sha: parentSha },
      );
      const baseTree = z.object({ tree: z.object({ sha }) }).parse(parent).tree.sha;
      const entryAt = treeWalker(baseTree);
      const tree = [];
      for (const change of options.changes) {
        const existing = await entryAt(change.path);
        if (
          existing !== null &&
          (existing.type !== "blob" || !REGULAR_FILE_MODES.has(existing.mode))
        ) {
          throw new GuardError(
            "PipeHeal only changes regular files (not symlinks, submodules or directories)",
          );
        }
        if ("delete" in change) {
          if (existing === null) throw new GuardError("can't delete a file that doesn't exist");
          tree.push({
            path: change.path,
            mode: "100644" as const,
            type: "blob" as const,
            sha: null,
          });
        } else {
          const mode = existing?.mode === "100755" ? ("100755" as const) : ("100644" as const);
          tree.push({ path: change.path, mode, type: "blob" as const, content: change.content });
        }
      }

      const { data: newTree } = await octokit.request("POST /repos/{owner}/{repo}/git/trees", {
        ...where,
        base_tree: baseTree,
        tree,
      });
      const { data: commit } = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
        ...where,
        message: options.message,
        tree: sha.parse(z.object({ sha }).parse(newTree).sha),
        parents: [parentSha],
      });
      const commitSha = sha.parse(z.object({ sha }).parse(commit).sha);
      if (options.createBranch) {
        await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
          ...where,
          ref: `refs/heads/${options.branch}`,
          sha: commitSha,
          ...NO_RETRY,
        });
      } else {
        await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
          ...where,
          ref: `heads/${options.branch}`,
          sha: commitSha,
          force: false,
          ...NO_RETRY,
        });
      }
      return { commitSha };
    },

    /** Opens a PR from a `pipeheal/*` branch of this repository (never from a fork). */
    async createPullRequest(options: {
      head: string;
      base: string;
      title: string;
      body: string;
      draft: boolean;
    }): Promise<PullRequest> {
      assertHealBranch(options.head);
      assertBranchName(options.base);
      const { data } = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
        ...where,
        head: options.head,
        base: options.base,
        title: options.title,
        body: options.body,
        draft: options.draft,
        maintainer_can_modify: false,
        ...NO_RETRY,
      });
      return toPullRequest(pullRequestSchema.parse(data));
    },

    getPullRequest,

    /** Comments on a pull request (never an issue, never a fork's PR). Never retried. */
    async comment(number: number, body: string): Promise<{ id: bigint; htmlUrl: string }> {
      if (body.length > MAX_COMMENT_CHARS) throw new GuardError("comment is too long for GitHub");
      await ownPullRequest(number);
      const { data } = await octokit.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        { ...where, issue_number: number, body, ...NO_RETRY },
      );
      const comment = z.object({ id, html_url: z.string() }).parse(data);
      return { id: comment.id, htmlUrl: comment.html_url };
    },

    /** Requests reviewers on one of PipeHeal's own PRs. */
    async requestReviewers(number: number, reviewers: string[]): Promise<void> {
      const logins = z.array(login).min(1).parse(reviewers);
      const pull = await ownPullRequest(number);
      if (!isHealBranch(pull.headRef)) {
        throw new GuardError("PipeHeal only requests reviews on its own pull requests");
      }
      await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", {
        ...where,
        pull_number: number,
        reviewers: logins,
      });
    },
  };
}

export type RepoClient = ReturnType<typeof repoClient>;
