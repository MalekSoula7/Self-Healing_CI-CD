// Typed wrappers for the repository endpoints PipeHeal uses, on an installation's client.
// Every response is validated with zod and mapped to a small domain type; nothing downstream
// sees GitHub's raw JSON. Writes go through the guards in ./guards.ts. There is deliberately no
// merge wrapper: PipeHeal never merges (CLAUDE.md).
import type { Octokit } from "octokit";
import { z } from "zod";
import {
  GuardError,
  assertHealBranch,
  assertRepoPath,
  assertWritablePath,
  parseFullName,
} from "./guards";

const id = z.number().int().positive().transform(BigInt);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const login = z.string().regex(/^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}(\[bot\])?$/);

const workflowRunSchema = z.object({
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
  head_repository: z.object({ full_name: z.string() }).nullable().optional(),
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
  head: z.object({ ref: z.string(), sha, repo: z.object({ full_name: z.string() }).nullable() }),
  base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }),
});

export type WorkflowRun = ReturnType<typeof toWorkflowRun>;
export type Job = ReturnType<typeof toJob>;
export type Workflow = ReturnType<typeof toWorkflow>;
export type Comparison = ReturnType<typeof toComparison>;
export type PullRequest = ReturnType<typeof toPullRequest>;

function toWorkflowRun(run: z.output<typeof workflowRunSchema>) {
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
    /** Null when the head repository was deleted; differs from the repo for fork PRs. */
    headRepositoryFullName: run.head_repository?.full_name ?? null,
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
    files: (comparison.files ?? []).map((file) => ({
      path: file.filename,
      previousPath: file.previous_filename ?? null,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      /** Absent for binary files and very large diffs. */
      patch: file.patch ?? null,
    })),
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
    /** From a fork (or a deleted head repo): PipeHeal never acts on these (CLAUDE.md). */
    fromFork: pull.head.repo?.full_name !== pull.base.repo.full_name,
  };
}

export type FileAtRef =
  | { kind: "text"; content: string; bytes: number }
  | { kind: "binary"; bytes: number }
  | { kind: "too_large"; maxBytes: number }
  | { kind: "not_a_file" };

export interface JobLog {
  /** The end of the log (errors are at the end), at most `maxBytes`, starting on a whole line. */
  text: string;
  truncated: boolean;
}

export type FileChange =
  { path: string; content: string; executable?: boolean } | { path: string; delete: true };

const MAX_COMMENT_CHARS = 65_536;

/** Reads a byte stream, keeping at most `maxBytes` from its end (`tail`) or failing past it. */
async function readBytes(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  keep: "tail" | "limit",
): Promise<{ bytes: Uint8Array; total: number; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (keep === "limit" && total > maxBytes) {
      // Stop the download; nothing to wait for.
      void reader.cancel().catch(() => undefined);
      return { bytes: new Uint8Array(), total, truncated: true };
    }
    chunks.push(value);
    kept += value.byteLength;
    while (kept - (chunks[0]?.byteLength ?? 0) >= maxBytes) {
      kept -= chunks.shift()?.byteLength ?? 0;
    }
  }
  const joined = Buffer.concat(chunks);
  const bytes =
    joined.byteLength > maxBytes ? joined.subarray(joined.byteLength - maxBytes) : joined;
  return { bytes, total, truncated: total > bytes.byteLength };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404;
}

/** A client for one repository of an installation. */
export function repoClient(octokit: Octokit, fullName: string) {
  const { owner, repo } = parseFullName(fullName);
  const where = { owner, repo };

  return {
    fullName: `${owner}/${repo}`,

    /** Every workflow run for a commit (SPEC §2.1 collection window). */
    async listRunsForSha(headSha: string): Promise<WorkflowRun[]> {
      const runs: unknown = await octokit.paginate("GET /repos/{owner}/{repo}/actions/runs", {
        ...where,
        head_sha: sha.parse(headSha),
        per_page: 100,
      });
      return z.array(workflowRunSchema).parse(runs).map(toWorkflowRun);
    },

    /** The jobs of one attempt of a run. */
    async listJobs(runId: bigint, attempt: number): Promise<Job[]> {
      const jobs: unknown = await octokit.paginate(
        "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs",
        { ...where, run_id: Number(runId), attempt_number: attempt, per_page: 100 },
      );
      return z.array(jobSchema).parse(jobs).map(toJob);
    },

    /** The jobs of one attempt that failed or timed out. */
    async listFailedJobs(runId: bigint, attempt: number): Promise<Job[]> {
      const jobs = await this.listJobs(runId, attempt);
      return jobs.filter((job) => job.conclusion === "failure" || job.conclusion === "timed_out");
    },

    /**
     * A job's log, streamed so a huge log never sits in memory whole. GitHub answers with a
     * redirect to a short-lived storage URL; fetch doesn't forward our token across origins.
     */
    async downloadJobLog(jobId: bigint, maxBytes = 5 * 1024 * 1024): Promise<JobLog> {
      const response = await octokit.request(
        "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs",
        { ...where, job_id: Number(jobId), request: { parseSuccessResponseBody: false } },
      );
      // parseSuccessResponseBody: false hands back fetch's body stream.
      const stream = response.data as ReadableStream<Uint8Array> | null;
      if (stream === null) return { text: "", truncated: false };
      const { bytes, truncated } = await readBytes(stream, maxBytes, "tail");
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

    /** A file's content at a commit; null when it doesn't exist there. */
    async getFileAtRef(
      path: string,
      ref: string,
      maxBytes = 1024 * 1024,
    ): Promise<FileAtRef | null> {
      assertRepoPath(path);
      let response;
      try {
        response = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
          ...where,
          path,
          ref: sha.parse(ref),
          mediaType: { format: "raw" },
          request: { parseSuccessResponseBody: false },
        });
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
      // A directory comes back as a JSON listing, not raw content.
      if (String(response.headers["content-type"]).startsWith("application/json")) {
        return { kind: "not_a_file" };
      }
      const stream = response.data as unknown as ReadableStream<Uint8Array> | null;
      if (stream === null) return { kind: "text", content: "", bytes: 0 };
      const { bytes, truncated, total } = await readBytes(stream, maxBytes, "limit");
      if (truncated) return { kind: "too_large", maxBytes };
      if (bytes.includes(0)) return { kind: "binary", bytes: total };
      return { kind: "text", content: new TextDecoder().decode(bytes), bytes: total };
    },

    async listWorkflows(): Promise<Workflow[]> {
      const workflows: unknown = await octokit.paginate(
        "GET /repos/{owner}/{repo}/actions/workflows",
        { ...where, per_page: 100 },
      );
      return z.array(workflowSchema).parse(workflows).map(toWorkflow);
    },

    /** Re-runs the failed jobs of a run's latest attempt (flaky check, SPEC §6.2). */
    async rerunFailedJobs(runId: bigint): Promise<void> {
      await octokit.request("POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs", {
        ...where,
        run_id: Number(runId),
      });
    },

    /**
     * Dispatches a workflow on `ref` (the healer, SPEC §5.3). Returns the run ID when GitHub
     * reports it (for the OIDC run_id check, SPEC §5.4).
     */
    async dispatchWorkflow(
      workflowPath: string,
      ref: string,
      inputs: Record<string, string>,
    ): Promise<{ runId: bigint | null }> {
      assertRepoPath(workflowPath);
      const file = /^\.github\/workflows\/([^/]+\.ya?ml)$/.exec(workflowPath)?.[1];
      if (file === undefined) throw new GuardError("not a workflow file path");
      const { data } = await octokit.request(
        "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
        { ...where, workflow_id: file, ref, inputs, return_run_details: true },
      );
      const details = z.object({ workflow_run_id: id }).safeParse(data);
      return { runId: details.success ? details.data.workflow_run_id : null };
    },

    /**
     * One commit on a `pipeheal/*` branch through the Git Data API (SPEC §9), on top of
     * `parentSha`. Creates the branch, or moves it forward; never forces.
     */
    async commitFiles(options: {
      branch: string;
      parentSha: string;
      message: string;
      changes: FileChange[];
      createBranch: boolean;
    }): Promise<{ commitSha: string }> {
      assertHealBranch(options.branch);
      if (options.changes.length === 0) throw new GuardError("a commit needs at least one change");
      for (const change of options.changes) assertWritablePath(change.path);
      const parentSha = sha.parse(options.parentSha);

      const { data: parent } = await octokit.request(
        "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
        { ...where, commit_sha: parentSha },
      );
      const baseTree = sha.parse(z.object({ tree: z.object({ sha }) }).parse(parent).tree.sha);
      const { data: tree } = await octokit.request("POST /repos/{owner}/{repo}/git/trees", {
        ...where,
        base_tree: baseTree,
        tree: options.changes.map((change) =>
          "delete" in change
            ? { path: change.path, mode: "100644" as const, type: "blob" as const, sha: null }
            : {
                path: change.path,
                mode: change.executable === true ? ("100755" as const) : ("100644" as const),
                type: "blob" as const,
                content: change.content,
              },
        ),
      });
      const { data: commit } = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
        ...where,
        message: options.message,
        tree: sha.parse(z.object({ sha }).parse(tree).sha),
        parents: [parentSha],
      });
      const commitSha = sha.parse(z.object({ sha }).parse(commit).sha);
      if (options.createBranch) {
        await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
          ...where,
          ref: `refs/heads/${options.branch}`,
          sha: commitSha,
        });
      } else {
        await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
          ...where,
          ref: `heads/${options.branch}`,
          sha: commitSha,
          force: false,
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
      const { data } = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
        ...where,
        head: options.head,
        base: options.base,
        title: options.title,
        body: options.body,
        draft: options.draft,
        maintainer_can_modify: false,
      });
      return toPullRequest(pullRequestSchema.parse(data));
    },

    async getPullRequest(number: number): Promise<PullRequest> {
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        ...where,
        pull_number: number,
      });
      return toPullRequest(pullRequestSchema.parse(data));
    },

    /** Comments on a PR or issue. */
    async comment(number: number, body: string): Promise<{ id: bigint; htmlUrl: string }> {
      if (body.length > MAX_COMMENT_CHARS) throw new GuardError("comment is too long for GitHub");
      const { data } = await octokit.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        { ...where, issue_number: number, body },
      );
      const comment = z.object({ id, html_url: z.string() }).parse(data);
      return { id: comment.id, htmlUrl: comment.html_url };
    },

    async requestReviewers(number: number, reviewers: string[]): Promise<void> {
      const logins = z.array(login).min(1).parse(reviewers);
      await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", {
        ...where,
        pull_number: number,
        reviewers: logins,
      });
    },
  };
}

export type RepoClient = ReturnType<typeof repoClient>;
