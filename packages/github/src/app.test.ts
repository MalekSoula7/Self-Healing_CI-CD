import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mockServer } from "@pipeheal/shared/testing";
import { delay, http, HttpResponse, type JsonBodyType } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { createGitHubApp } from "./app";
import { GitHubApiError } from "./client";
import { GuardError } from "./guards";

const API = "https://api.github.com";
const REPO = `${API}/repos/octo-org/app`;
const REPO_ID = 1001;
const INSTALLATION_TOKEN = "ghs_installationTokenForTests0000000000";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const TREE = "1".repeat(40);

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

let tokenRequests: { authorization: string | null; installationId: string }[];
let apiAuthorizations: (string | null)[];

beforeEach(() => {
  tokenRequests = [];
  apiAuthorizations = [];
  mockServer.use(
    http.post(`${API}/app/installations/:installationId/access_tokens`, ({ request, params }) => {
      tokenRequests.push({
        authorization: request.headers.get("authorization"),
        installationId: String(params.installationId),
      });
      return HttpResponse.json(
        {
          token: INSTALLATION_TOKEN,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: {},
          repository_selection: "all",
        },
        { status: 201 },
      );
    }),
  );
});

function createApp(options: { requestTimeoutMs?: number; retries?: number } = {}) {
  return createGitHubApp({
    appId: 1234,
    privateKey,
    retries: options.retries ?? 0,
    retryAfterMs: 1,
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
  });
}

async function repo(options?: { requestTimeoutMs?: number; retries?: number }) {
  return (await createApp(options).installation(42n)).repo("octo-org/app");
}

/** Records the Authorization header of a mocked API call, then answers with `body`. */
function recording(body: JsonBodyType, init?: ResponseInit) {
  return ({ request }: { request: Request }) => {
    apiAuthorizations.push(request.headers.get("authorization"));
    return HttpResponse.json(body, init);
  };
}

function run(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    run_attempt: 1,
    workflow_id: 7,
    name: "CI",
    path: ".github/workflows/ci.yml",
    head_sha: SHA_A,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "failure",
    html_url: `https://github.com/octo-org/app/actions/runs/${String(id)}`,
    repository: { id: REPO_ID, full_name: "octo-org/app" },
    head_repository: { id: REPO_ID, full_name: "octo-org/app" },
    ...overrides,
  };
}

function job(id: number, conclusion: string | null) {
  return {
    id,
    run_id: 99,
    run_attempt: 2,
    name: `job-${String(id)}`,
    status: "completed",
    conclusion,
    html_url: null,
    steps: [
      { name: "Checkout", number: 1, conclusion: "success" },
      { name: "Test", number: 2, conclusion: conclusion === "failure" ? "failure" : "success" },
    ],
  };
}

const ownRepo = { id: REPO_ID, full_name: "octo-org/app" };
const forkHead = {
  ref: "pipeheal/abc-1",
  sha: SHA_B,
  repo: { id: 999, full_name: "octo-org/app" },
};

function pull(overrides: Record<string, unknown> = {}) {
  return {
    number: 12,
    html_url: "https://github.com/octo-org/app/pull/12",
    state: "open",
    draft: true,
    merged: false,
    head: { ref: "pipeheal/abc-1", sha: SHA_B, repo: ownRepo },
    base: { ref: "main", repo: ownRepo },
    ...overrides,
  };
}

describe("App authentication", () => {
  it("signs a short-lived JWT with the App's key to get an installation token", async () => {
    mockServer.use(
      http.get(`${REPO}/actions/workflows`, recording({ total_count: 0, workflows: [] })),
    );
    await (await repo()).listWorkflows();

    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]?.installationId).toBe("42");
    const jwt = tokenRequests[0]?.authorization?.replace(/^bearer /i, "") ?? "";
    const [header = "", payload = "", signature = ""] = jwt.split(".");
    const valid = verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      createPublicKey(publicKey),
      Buffer.from(signature, "base64url"),
    );
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      iss: unknown;
      iat: number;
      exp: number;
    };
    expect(valid).toBe(true);
    expect(String(claims.iss)).toBe("1234");
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(11 * 60);
    expect(apiAuthorizations).toEqual([`token ${INSTALLATION_TOKEN}`]);
  });

  it("reuses the installation token until it nears expiry", async () => {
    mockServer.use(
      http.get(`${REPO}/actions/workflows`, recording({ total_count: 0, workflows: [] })),
    );
    const app = createApp();

    await (await app.installation(42n)).repo("octo-org/app").listWorkflows();
    await (await app.installation(42n)).repo("octo-org/app").listWorkflows();

    expect(tokenRequests).toHaveLength(1);
    expect(apiAuthorizations).toHaveLength(2);
  });

  it("lists the installation's repositories, all pages", async () => {
    mockServer.use(
      http.get(`${API}/installation/repositories`, ({ request }) =>
        new URL(request.url).searchParams.get("page") === "2"
          ? HttpResponse.json({
              total_count: 2,
              repositories: [{ id: 2, full_name: "octo-org/b", default_branch: "dev" }],
            })
          : HttpResponse.json(
              {
                total_count: 2,
                repositories: [
                  { id: 1, full_name: "octo-org/a", default_branch: "main", archived: true },
                ],
              },
              { headers: { link: `<${API}/installation/repositories?page=2>; rel="next"` } },
            ),
      ),
    );

    const repositories = await (await createApp().installation(42n)).listRepositories();

    expect(repositories).toEqual([
      { githubRepoId: 1n, fullName: "octo-org/a", defaultBranch: "main", archived: true },
      { githubRepoId: 2n, fullName: "octo-org/b", defaultBranch: "dev", archived: false },
    ]);
  });
});

describe("workflow runs and jobs", () => {
  it("lists every run of a commit", async () => {
    let query: URLSearchParams | undefined;
    mockServer.use(
      http.get(`${REPO}/actions/runs`, ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json({ total_count: 1, workflow_runs: [run(5)] });
      }),
    );

    const runs = await (await repo()).listRunsForSha(SHA_A);

    expect(query?.get("head_sha")).toBe(SHA_A);
    expect(runs).toEqual([
      expect.objectContaining({ id: 5n, workflowId: 7n, headSha: SHA_A, fromFork: false }),
    ]);
  });

  it.each([
    ["another repository with the same name", { id: 999, full_name: "octo-org/app" }],
    ["a deleted head repository", null],
    ["no head repository at all", undefined],
  ])("marks a run from %s as a fork (fail closed)", async (_label, headRepository) => {
    mockServer.use(
      http.get(`${REPO}/actions/runs`, () =>
        HttpResponse.json({
          total_count: 1,
          workflow_runs: [run(5, { head_repository: headRepository })],
        }),
      ),
    );

    const [first] = await (await repo()).listRunsForSha(SHA_A);

    expect(first?.fromFork).toBe(true);
  });

  it("refuses a malformed SHA before calling GitHub", async () => {
    await expect((await repo()).listRunsForSha("main")).rejects.toThrow(ZodError);
  });

  it("lists the failed jobs of one attempt with their failed step", async () => {
    let path = "";
    mockServer.use(
      http.get(`${REPO}/actions/runs/99/attempts/2/jobs`, ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({
          total_count: 3,
          jobs: [job(1, "success"), job(2, "failure"), job(3, "timed_out")],
        });
      }),
    );

    const failed = await (await repo()).listFailedJobs(99n, 2);

    expect(path).toBe("/repos/octo-org/app/actions/runs/99/attempts/2/jobs");
    expect(failed.map((j) => [j.id, j.conclusion, j.failedStep])).toEqual([
      [2n, "failure", "Test"],
      [3n, "timed_out", null],
    ]);
  });

  it("rejects a response that doesn't look like GitHub's", async () => {
    mockServer.use(
      http.get(`${REPO}/actions/runs`, () =>
        HttpResponse.json({ total_count: 1, workflow_runs: [run(5, { head_sha: "not-a-sha" })] }),
      ),
    );

    await expect((await repo()).listRunsForSha(SHA_A)).rejects.toThrow(ZodError);
  });
});

describe("job logs", () => {
  const STORAGE_URL = "https://results-receiver.actions.githubusercontent.com/logs/job-7.txt";
  const SIGNED_URL = `${STORAGE_URL}?sig=signed-secret`;

  function serveLog(chunks: string[], options: { location?: string; status?: number } = {}) {
    const seen: { storageAuthorization?: string | null } = {};
    mockServer.use(
      http.get(
        `${REPO}/actions/jobs/7/logs`,
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { location: options.location ?? SIGNED_URL },
          }),
      ),
      http.get(STORAGE_URL, ({ request }) => {
        seen.storageAuthorization = request.headers.get("authorization");
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        });
        return new HttpResponse(body, { status: options.status ?? 200 });
      }),
    );
    return seen;
  }

  it("follows GitHub's redirect to log storage itself, without our token", async () => {
    const seen = serveLog(["line 1\nErr", "or: boom\n"]);

    const log = await (await repo()).downloadJobLog(7n);

    expect(log).toEqual({ text: "line 1\nError: boom\n", truncated: false });
    expect(seen.storageAuthorization).toBeNull();
  });

  it("keeps only the end of a huge log, streamed in chunks, from a whole line", async () => {
    const lines = Array.from({ length: 2_000 }, (_, i) => `line ${String(i)}\n`);
    serveLog([...lines, "Error: the real failure\n"]);

    const log = await (await repo()).downloadJobLog(7n, 1_000);

    expect(log.truncated).toBe(true);
    expect(Buffer.byteLength(log.text)).toBeLessThanOrEqual(1_000);
    expect(log.text).toMatch(/^line \d+\n/);
    expect(log.text.endsWith("Error: the real failure\n")).toBe(true);
  });

  it.each([
    "https://evil.example/logs/job-7.txt",
    "http://results-receiver.actions.githubusercontent.com/logs/job-7.txt",
    "https://actions.githubusercontent.com.evil.example/x",
  ])("refuses a redirect to %s", async (location) => {
    serveLog(["x"], { location });

    await expect((await repo()).downloadJobLog(7n)).rejects.toThrow(GuardError);
  });

  it("fails on a storage error without the signed URL", async () => {
    serveLog(["denied"], { status: 403 });

    const error: unknown = await (await repo()).downloadJobLog(7n).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(JSON.stringify(error) + String(error)).not.toContain("signed-secret");
  });
});

describe("files and comparisons", () => {
  it("compares two commits and says when GitHub cut the lists short", async () => {
    let path = "";
    const manyFiles = Array.from({ length: 300 }, (_, i) => ({
      filename: `f${String(i)}.ts`,
      status: "modified",
      additions: 1,
      deletions: 0,
    }));
    mockServer.use(
      http.get(`${REPO}/compare/:basehead`, ({ request }) => {
        path = decodeURIComponent(new URL(request.url).pathname);
        return HttpResponse.json({
          status: "ahead",
          ahead_by: 400,
          behind_by: 0,
          total_commits: 400,
          commits: [{ sha: SHA_B, commit: { message: "fix: x" }, author: null }],
          files: manyFiles,
        });
      }),
    );

    const comparison = await (await repo()).compareCommits(SHA_A, SHA_B);

    expect(path).toBe(`/repos/octo-org/app/compare/${SHA_A}...${SHA_B}`);
    expect(comparison.commits).toEqual([{ sha: SHA_B, message: "fix: x", authorLogin: null }]);
    expect(comparison.commitsTruncated).toBe(true);
    expect(comparison.filesTruncated).toBe(true);
  });

  function serveContent(body: JsonBodyType, init?: ResponseInit) {
    let seenPath = "";
    mockServer.use(
      http.get(`${REPO}/contents/*`, ({ request }) => {
        // octokit percent-encodes the slashes of {path}; GitHub decodes them.
        const url = new URL(request.url);
        seenPath = decodeURIComponent(url.pathname) + url.search;
        return HttpResponse.json(body, init);
      }),
    );
    return () => seenPath;
  }

  function fileContent(path: string, data: Uint8Array | string) {
    const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    return {
      type: "file",
      path,
      size: bytes.byteLength,
      encoding: "base64",
      content: bytes.toString("base64").replace(/(.{60})/g, "$1\n"),
    };
  }

  it("reads a text file at a commit exactly", async () => {
    const source = "export const café = 1;\n";
    const seenPath = serveContent(fileContent("src/lib/x.ts", source));

    await expect((await repo()).getFileAtRef("src/lib/x.ts", SHA_A)).resolves.toEqual({
      kind: "text",
      content: source,
      bytes: Buffer.byteLength(source),
    });
    expect(seenPath()).toBe(`/repos/octo-org/app/contents/src/lib/x.ts?ref=${SHA_A}`);
  });

  it("keeps a byte-order mark, so writing the file back doesn't change it", async () => {
    serveContent(fileContent("a.cs", "﻿class A {}\n"));

    const file = await (await repo()).getFileAtRef("a.cs", SHA_A);

    expect(file).toMatchObject({ kind: "text", content: "﻿class A {}\n" });
  });

  it.each([
    ["a NUL byte", new Uint8Array([0x89, 0x50, 0x00, 0x47])],
    ["invalid UTF-8", new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a])],
  ])("treats %s as binary", async (_label, bytes) => {
    serveContent(fileContent("data.bin", bytes));

    await expect((await repo()).getFileAtRef("data.bin", SHA_A)).resolves.toEqual({
      kind: "binary",
      bytes: bytes.byteLength,
    });
  });

  it("recognizes large files, directories, symlinks, submodules and missing files", async () => {
    const client = await repo();

    serveContent({ type: "file", path: "big.txt", size: 5_000_000, encoding: "none", content: "" });
    await expect(client.getFileAtRef("big.txt", SHA_A)).resolves.toEqual({
      kind: "too_large",
      bytes: 5_000_000,
      maxBytes: 1024 * 1024,
    });

    serveContent([{ type: "file", path: "src/a.ts" }]);
    await expect(client.getFileAtRef("src", SHA_A)).resolves.toEqual({ kind: "not_a_file" });

    serveContent({ type: "symlink", path: "link", size: 5, target: "../x" });
    await expect(client.getFileAtRef("link", SHA_A)).resolves.toEqual({ kind: "symlink" });

    // A symlink to a file: GitHub answers with the target file, under the target's path.
    serveContent(fileContent("real/config.json", "{}"));
    await expect(client.getFileAtRef("config.json", SHA_A)).resolves.toEqual({ kind: "symlink" });

    serveContent({ type: "submodule", path: "vendor/lib", size: 0, submodule_git_url: "x" });
    await expect(client.getFileAtRef("vendor/lib", SHA_A)).resolves.toEqual({
      kind: "submodule",
    });

    serveContent({ message: "Not Found" }, { status: 404 });
    await expect(client.getFileAtRef("gone.ts", SHA_A)).resolves.toBeNull();
  });

  it("refuses path traversal before calling GitHub", async () => {
    await expect((await repo()).getFileAtRef("../secrets", SHA_A)).rejects.toThrow(GuardError);
  });
});

describe("branches", () => {
  it("returns the commit SHA a branch points at", async () => {
    let path = "";
    mockServer.use(
      http.get(`${REPO}/git/ref/*`, ({ request }) => {
        path = decodeURIComponent(new URL(request.url).pathname);
        return HttpResponse.json({
          ref: "refs/heads/main",
          object: { sha: SHA_A, type: "commit" },
        });
      }),
    );

    await expect((await repo()).getBranchSha("main")).resolves.toBe(SHA_A);

    expect(path).toBe("/repos/octo-org/app/git/ref/heads/main");
  });

  it("returns null for a branch that doesn't exist", async () => {
    mockServer.use(
      http.get(`${REPO}/git/ref/*`, () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
    );

    await expect((await repo()).getBranchSha("no-such-branch")).resolves.toBeNull();
  });

  // Seen on a real installation: a repository created without any commit.
  it("returns null for an empty repository, which GitHub answers with 409", async () => {
    mockServer.use(
      http.get(`${REPO}/git/ref/*`, () =>
        HttpResponse.json({ message: "Git Repository is empty." }, { status: 409 }),
      ),
    );

    await expect((await repo()).getBranchSha("main")).resolves.toBeNull();
  });

  it("refuses an invalid branch name before calling GitHub", async () => {
    await expect((await repo()).getBranchSha("../etc")).rejects.toThrow(GuardError);
  });
});

describe("actions", () => {
  it("lists workflows", async () => {
    mockServer.use(
      http.get(`${REPO}/actions/workflows`, () =>
        HttpResponse.json({
          total_count: 1,
          workflows: [{ id: 7, name: "CI", path: ".github/workflows/ci.yml", state: "active" }],
        }),
      ),
    );

    await expect((await repo()).listWorkflows()).resolves.toEqual([
      { id: 7n, name: "CI", path: ".github/workflows/ci.yml", state: "active" },
    ]);
  });

  it("re-runs a run's failed jobs, but never a fork's", async () => {
    const reruns: string[] = [];
    mockServer.use(
      http.get(`${REPO}/actions/runs/:id`, ({ params }) =>
        HttpResponse.json(
          params.id === "98"
            ? run(98, { head_repository: { id: 999, full_name: "someone/app" } })
            : run(99),
        ),
      ),
      http.post(`${REPO}/actions/runs/:id/rerun-failed-jobs`, ({ params }) => {
        reruns.push(String(params.id));
        return new HttpResponse(null, { status: 201 });
      }),
    );
    const client = await repo();

    await client.rerunFailedJobs(99n);
    await expect(client.rerunFailedJobs(98n)).rejects.toThrow(GuardError);

    expect(reruns).toEqual(["99"]);
  });

  it("dispatches the healer with its inputs and returns the run ID", async () => {
    let body: unknown;
    let path = "";
    mockServer.use(
      http.post(`${REPO}/actions/workflows/:workflow/dispatches`, async ({ request }) => {
        path = new URL(request.url).pathname;
        body = await request.json();
        return HttpResponse.json({ workflow_run_id: 555, run_url: "x", html_url: "y" });
      }),
    );

    const result = await (
      await repo()
    ).dispatchWorkflow(".github/workflows/pipeheal.yml", "main", {
      job_id: "job-1",
      target_sha: SHA_A,
    });

    expect(path).toBe("/repos/octo-org/app/actions/workflows/pipeheal.yml/dispatches");
    expect(body).toEqual({
      ref: "main",
      inputs: { job_id: "job-1", target_sha: SHA_A },
      return_run_details: true,
    });
    expect(result).toEqual({ runId: 555n });
  });

  it("returns no run ID when GitHub doesn't report one", async () => {
    mockServer.use(
      http.post(
        `${REPO}/actions/workflows/:workflow/dispatches`,
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    await expect(
      (await repo()).dispatchWorkflow(".github/workflows/pipeheal.yml", "main", {}),
    ).resolves.toEqual({ runId: null });
  });

  it("never retries a dispatch (a retry could start a second healer run)", async () => {
    let calls = 0;
    mockServer.use(
      http.post(`${REPO}/actions/workflows/:workflow/dispatches`, () => {
        calls += 1;
        return HttpResponse.json({ message: "Server Error" }, { status: 502 });
      }),
    );

    await expect(
      (await repo({ retries: 3 })).dispatchWorkflow(".github/workflows/pipeheal.yml", "main", {}),
    ).rejects.toThrow(GitHubApiError);
    expect(calls).toBe(1);
  });

  it.each([
    ["pipeheal.yml", "main"],
    [".github/workflows/../ci.yml", "main"],
    ["src/workflow.yml", "main"],
    [".github/workflows/a/b.yml", "main"],
    [".github/workflows/pipeheal.yml", "main..evil"],
    [".github/workflows/pipeheal.yml", "-x"],
  ])("refuses to dispatch %s on %s", async (path, ref) => {
    await expect((await repo()).dispatchWorkflow(path, ref, {})).rejects.toThrow(GuardError);
  });
});

describe("commits (Git Data API)", () => {
  interface TreeEntry {
    path: string;
    mode: string;
    type: string;
    sha: string;
  }

  const blob = (path: string, mode = "100644"): TreeEntry => ({
    path,
    mode,
    type: "blob",
    sha: "4".repeat(40),
  });
  const SRC_TREE = "5".repeat(40);

  function serveGitData(options: { root?: TreeEntry[]; branchTip?: string } = {}) {
    const root = options.root ?? [
      { path: "src", mode: "040000", type: "tree", sha: SRC_TREE },
      blob("old.ts"),
      blob("run.sh", "100755"),
    ];
    const subtrees: Record<string, TreeEntry[]> = { [SRC_TREE]: [blob("a.ts")] };
    const calls: { method: string; path: string; body: unknown }[] = [];
    const record = async (request: Request) => {
      calls.push({
        method: request.method,
        path: decodeURIComponent(new URL(request.url).pathname),
        body: request.method === "GET" ? null : await request.json(),
      });
    };
    mockServer.use(
      http.get(`${REPO}/git/ref/*`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ ref: "x", object: { sha: options.branchTip ?? SHA_A } });
      }),
      http.get(`${REPO}/git/commits/:sha`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ sha: SHA_A, tree: { sha: TREE } });
      }),
      http.get(`${REPO}/git/trees/:sha`, async ({ request, params }) => {
        await record(request);
        const sha = String(params.sha);
        return HttpResponse.json({ sha, tree: sha === TREE ? root : (subtrees[sha] ?? []) });
      }),
      http.post(`${REPO}/git/trees`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ sha: "2".repeat(40) }, { status: 201 });
      }),
      http.post(`${REPO}/git/commits`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ sha: "3".repeat(40) }, { status: 201 });
      }),
      http.post(`${REPO}/git/refs`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ ref: "x" }, { status: 201 });
      }),
      http.patch(`${REPO}/git/refs/*`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ ref: "x" });
      }),
    );
    return calls;
  }

  const writesIn = (calls: { method: string }[]) => calls.filter((call) => call.method !== "GET");

  function commit(overrides: Record<string, unknown> = {}) {
    return {
      branch: "pipeheal/abc-1",
      parentSha: SHA_A,
      message: "fix: x [PipeHeal]",
      changes: [
        { path: "src/a.ts", content: "export {};\n" },
        { path: "run.sh", content: "#!/bin/sh\n" },
        { path: "src/new.ts", content: "new\n" },
        { path: "old.ts", delete: true as const },
      ],
      createBranch: true,
      ...overrides,
    };
  }

  it("creates a pipeheal/* branch with one commit, keeping each file's mode", async () => {
    const calls = serveGitData();

    const result = await (await repo()).commitFiles(commit());

    expect(result).toEqual({ commitSha: "3".repeat(40) });
    expect(writesIn(calls)).toEqual([
      {
        method: "POST",
        path: "/repos/octo-org/app/git/trees",
        body: {
          base_tree: TREE,
          tree: [
            { path: "src/a.ts", mode: "100644", type: "blob", content: "export {};\n" },
            { path: "run.sh", mode: "100755", type: "blob", content: "#!/bin/sh\n" },
            { path: "src/new.ts", mode: "100644", type: "blob", content: "new\n" },
            { path: "old.ts", mode: "100644", type: "blob", sha: null },
          ],
        },
      },
      {
        method: "POST",
        path: "/repos/octo-org/app/git/commits",
        body: { message: "fix: x [PipeHeal]", tree: "2".repeat(40), parents: [SHA_A] },
      },
      {
        method: "POST",
        path: "/repos/octo-org/app/git/refs",
        body: { ref: "refs/heads/pipeheal/abc-1", sha: "3".repeat(40) },
      },
    ]);
  });

  it("moves its own branch forward from its last commit, never forcing", async () => {
    const calls = serveGitData();

    await (
      await repo()
    ).commitFiles(commit({ createBranch: false, changes: [{ path: "src/a.ts", content: "x" }] }));

    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/repos/octo-org/app/git/ref/heads/pipeheal/abc-1",
    });
    expect(calls.at(-1)).toEqual({
      method: "PATCH",
      path: "/repos/octo-org/app/git/refs/heads/pipeheal/abc-1",
      body: { sha: "3".repeat(40), force: false },
    });
  });

  it("refuses to extend a branch that moved (someone else pushed to it)", async () => {
    const calls = serveGitData({ branchTip: SHA_B });

    await expect(
      (await repo()).commitFiles(
        commit({ createBranch: false, changes: [{ path: "src/a.ts", content: "x" }] }),
      ),
    ).rejects.toThrow(GuardError);
    expect(writesIn(calls)).toEqual([]);
  });

  it.each([
    ["a symlink", { path: "link", mode: "120000", type: "blob", sha: "6".repeat(40) }, "link"],
    [
      "a submodule",
      { path: "vendor", mode: "160000", type: "commit", sha: "6".repeat(40) },
      "vendor",
    ],
    ["a directory", { path: "src", mode: "040000", type: "tree", sha: SRC_TREE }, "src"],
    [
      "a path through a symlink",
      { path: "link", mode: "120000", type: "blob", sha: "6".repeat(40) },
      "link/x.ts",
    ],
  ])("refuses to write over %s", async (_label, entry, path) => {
    const calls = serveGitData({ root: [entry] });

    await expect(
      (await repo()).commitFiles(commit({ changes: [{ path, content: "x" }] })),
    ).rejects.toThrow(GuardError);
    expect(writesIn(calls)).toEqual([]);
  });

  it.each([
    ["another branch", { branch: "main" }],
    ["a look-alike branch", { branch: "pipeheal-x" }],
    ["a file under .github/", { changes: [{ path: ".github/workflows/ci.yml", content: "x" }] }],
    ["a file under .GitHub/", { changes: [{ path: ".GitHub/CODEOWNERS", content: "x" }] }],
    [
      "a deletion under .github/",
      { changes: [{ path: ".github/dependabot.yml", delete: true as const }] },
    ],
    [
      "a nested .git directory",
      { changes: [{ path: "vendor/x/.git/hooks/post-checkout", content: "x" }] },
    ],
    ["a Windows-reserved name", { changes: [{ path: "src/aux.ts", content: "x" }] }],
    ["path traversal", { changes: [{ path: "../x", content: "x" }] }],
    [
      "the same path twice",
      {
        changes: [
          { path: "a", content: "1" },
          { path: "a", content: "2" },
        ],
      },
    ],
    ["an empty commit", { changes: [] }],
    ["a message that skips CI", { message: "fix: x [skip ci]" }],
    ["deleting a missing file", { changes: [{ path: "nope.ts", delete: true as const }] }],
  ])("refuses %s before writing anything", async (_label, override) => {
    const calls = serveGitData();

    await expect((await repo()).commitFiles(commit(override))).rejects.toThrow(GuardError);
    expect(writesIn(calls)).toEqual([]);
  });
});

describe("pull requests", () => {
  it("opens a PR from a pipeheal/* branch, without maintainer edits", async () => {
    let body: unknown;
    mockServer.use(
      http.post(`${REPO}/pulls`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(pull(), { status: 201 });
      }),
    );

    const created = await (
      await repo()
    ).createPullRequest({
      head: "pipeheal/abc-1",
      base: "main",
      title: "fix: x [PipeHeal]",
      body: "## What failed",
      draft: true,
    });

    expect(body).toEqual({
      head: "pipeheal/abc-1",
      base: "main",
      title: "fix: x [PipeHeal]",
      body: "## What failed",
      draft: true,
      maintainer_can_modify: false,
    });
    expect(created).toMatchObject({ number: 12, draft: true, fromFork: false });
  });

  it("refuses to open a PR from another branch or a fork", async () => {
    const client = await repo();
    for (const head of ["main", "someone:pipeheal/abc-1"]) {
      await expect(
        client.createPullRequest({ head, base: "main", title: "t", body: "b", draft: false }),
      ).rejects.toThrow(GuardError);
    }
  });

  it("tells PRs from forks apart by repository ID", async () => {
    mockServer.use(
      http.get(`${REPO}/pulls/:number`, ({ params }) =>
        HttpResponse.json(
          params.number === "13"
            ? pull({ number: 13, head: forkHead })
            : pull({ number: 14, head: { ref: "patch", sha: SHA_B, repo: null } }),
        ),
      ),
    );
    const client = await repo();

    await expect(client.getPullRequest(13)).resolves.toMatchObject({ fromFork: true });
    await expect(client.getPullRequest(14)).resolves.toMatchObject({ fromFork: true });
  });

  function servePullActions(pullBody: JsonBodyType | null) {
    const writes: unknown[] = [];
    mockServer.use(
      http.get(`${REPO}/pulls/:number`, () =>
        pullBody === null
          ? HttpResponse.json({ message: "Not Found" }, { status: 404 })
          : HttpResponse.json(pullBody),
      ),
      http.post(`${REPO}/issues/12/comments`, async ({ request }) => {
        writes.push(await request.json());
        return HttpResponse.json(
          { id: 900, html_url: "https://github.com/c/900" },
          { status: 201 },
        );
      }),
      http.post(`${REPO}/pulls/12/requested_reviewers`, async ({ request }) => {
        writes.push(await request.json());
        return HttpResponse.json(pull(), { status: 201 });
      }),
    );
    return writes;
  }

  it("comments on its PRs and requests reviewers", async () => {
    const writes = servePullActions(pull());
    const client = await repo();

    await expect(client.comment(12, "Diagnosis")).resolves.toEqual({
      id: 900n,
      htmlUrl: "https://github.com/c/900",
    });
    await client.requestReviewers(12, ["octo-dev"]);

    expect(writes).toEqual([{ body: "Diagnosis" }, { reviewers: ["octo-dev"] }]);
  });

  it.each([
    ["a fork's PR", pull({ head: forkHead })],
    ["an issue", null],
  ])("never comments on %s", async (_label, pullBody) => {
    const writes = servePullActions(pullBody);

    await expect((await repo()).comment(12, "Diagnosis")).rejects.toThrow(GuardError);
    expect(writes).toEqual([]);
  });

  it("requests reviews only on its own PRs, with valid logins", async () => {
    const writes = servePullActions(pull({ head: { ref: "feature", sha: SHA_B, repo: ownRepo } }));
    const client = await repo();

    await expect(client.requestReviewers(12, ["octo-dev"])).rejects.toThrow(GuardError);
    await expect(client.requestReviewers(12, ["not a login"])).rejects.toThrow(ZodError);
    await expect(client.requestReviewers(12, [])).rejects.toThrow(ZodError);
    await expect(client.comment(12, "x".repeat(65_537))).rejects.toThrow(GuardError);
    expect(writes).toEqual([]);
  });

  it("has no way to merge (PipeHeal never merges)", async () => {
    const client = await repo();
    expect(Object.keys(client).filter((key) => /merge/i.test(key))).toEqual([]);
  });
});

describe("resilience and errors", () => {
  it("retries a 5xx on a read, then succeeds", async () => {
    let calls = 0;
    mockServer.use(
      http.get(`${REPO}/actions/workflows`, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ message: "Server Error" }, { status: 502 })
          : HttpResponse.json({ total_count: 0, workflows: [] });
      }),
    );

    await expect((await repo({ retries: 2 })).listWorkflows()).resolves.toEqual([]);
    expect(calls).toBe(2);
  });

  it("gives up on a request that takes too long", async () => {
    mockServer.use(
      http.get(`${REPO}/actions/workflows`, async () => {
        await delay(2_000);
        return HttpResponse.json({ total_count: 0, workflows: [] });
      }),
    );

    const started = Date.now();
    await expect((await repo({ requestTimeoutMs: 100 })).listWorkflows()).rejects.toThrow(
      GitHubApiError,
    );
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("reports failures as GitHubApiError: status, route template, request ID, nothing else", async () => {
    const secretCode = "const apiKey = 'customer-secret-code';";
    mockServer.use(
      http.get(`${REPO}/git/commits/:sha`, () =>
        HttpResponse.json({ sha: SHA_A, tree: { sha: TREE } }),
      ),
      http.get(`${REPO}/git/trees/:sha`, () => HttpResponse.json({ sha: TREE, tree: [] })),
      http.post(`${REPO}/git/trees`, () =>
        HttpResponse.json(
          { message: "Validation Failed", documentation_url: "x" },
          { status: 422, headers: { "x-github-request-id": "ABCD:1234" } },
        ),
      ),
    );

    const error: unknown = await (
      await repo()
    )
      .commitFiles({
        branch: "pipeheal/abc-1",
        parentSha: SHA_A,
        message: "fix: x",
        changes: [{ path: "src/new.ts", content: secretCode }],
        createBranch: true,
      })
      .then(
        () => null,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({
      status: 422,
      route: "POST /repos/{owner}/{repo}/git/trees",
      requestId: "ABCD:1234",
      message: "GitHub answered 422 to POST /repos/{owner}/{repo}/git/trees: Validation Failed",
    });
    const everything = `${JSON.stringify(error)} ${String(error)} ${error instanceof Error ? String(error.stack) : ""}`;
    expect(everything).not.toContain("customer-secret-code");
    expect(everything).not.toContain(INSTALLATION_TOKEN);
    expect(everything).not.toContain("octo-org");
  });
});

describe("rate limits", () => {
  const RESET = Math.floor(Date.now() / 1000) + 1800;

  it("tells the caller each installation's remaining quota after every response", async () => {
    const reported: { installationId: bigint; remaining: number; resetAt: Date }[] = [];
    const app = createGitHubApp({
      appId: 1234,
      privateKey,
      retries: 0,
      onRateLimit: (installationId, state) => reported.push({ installationId, ...state }),
    });
    mockServer.use(
      http.get(`${REPO}/actions/workflows`, () =>
        HttpResponse.json(
          { total_count: 0, workflows: [] },
          { headers: { "x-ratelimit-remaining": "4321", "x-ratelimit-reset": String(RESET) } },
        ),
      ),
    );

    await (await app.installation(42n)).repo("octo-org/app").listWorkflows();

    expect(reported).toEqual([
      { installationId: 42n, remaining: 4321, resetAt: new Date(RESET * 1000) },
    ]);
  });

  async function failure(status: number, headers: Record<string, string>, message: string) {
    let calls = 0;
    mockServer.use(
      http.get(`${REPO}/actions/workflows`, () => {
        calls += 1;
        return HttpResponse.json({ message }, { status, headers });
      }),
    );
    const error = await (await repo({ retries: 2 })).listWorkflows().then(
      () => null,
      (reason: unknown) => reason,
    );
    if (!(error instanceof GitHubApiError)) throw new Error("expected a GitHubApiError");
    return { error, calls };
  }

  it("says when to retry after the primary quota runs out, and doesn't retry at once", async () => {
    const { error, calls } = await failure(
      403,
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(RESET) },
      "API rate limit exceeded for installation ID 42.",
    );

    expect(error.retryAt).toEqual(new Date(RESET * 1000));
    expect(calls).toBe(1);
  });

  it("honors retry-after on a 429, and doesn't retry it at once", async () => {
    const before = Date.now();
    const { error, calls } = await failure(429, { "retry-after": "30" }, "Too many requests");

    expect(error.status).toBe(429);
    expect(error.retryAt?.getTime()).toBeGreaterThanOrEqual(before + 30_000);
    expect(error.retryAt?.getTime()).toBeLessThan(before + 31_000);
    expect(calls).toBe(1);
  });

  it("waits a minute after a secondary rate limit that gives no retry-after", async () => {
    const before = Date.now();
    const { error } = await failure(403, {}, "You have exceeded a secondary rate limit.");

    expect(error.retryAt?.getTime()).toBeGreaterThanOrEqual(before + 60_000);
  });

  it("keeps the rate limit of the installation token fetch a call triggered", async () => {
    mockServer.use(
      http.post(`${API}/app/installations/:installationId/access_tokens`, () =>
        HttpResponse.json(
          { message: "API rate limit exceeded" },
          {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(RESET) },
          },
        ),
      ),
    );

    const error: unknown = await (await createApp().installation(42n)).listRepositories().then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({
      status: 403,
      route: "POST /app/installations/{installation_id}/access_tokens",
      retryAt: new Date(RESET * 1000),
    });
  });

  it("doesn't treat a plain 403 (missing permission) as a rate limit", async () => {
    const { error } = await failure(
      403,
      { "x-ratelimit-remaining": "4000", "x-ratelimit-reset": String(RESET) },
      "Resource not accessible by integration",
    );

    expect(error.retryAt).toBeNull();
  });
});
