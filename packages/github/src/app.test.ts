import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mockServer } from "@pipeheal/shared/testing";
import { delay, http, HttpResponse, type JsonBodyType } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { createGitHubApp } from "./app";
import { GuardError } from "./guards";

const API = "https://api.github.com";
const REPO = `${API}/repos/octo-org/app`;
const INSTALLATION_TOKEN = "ghs_installationTokenForTests0000000000";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

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
    pacing: false,
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
    head_repository: { full_name: "octo-org/app" },
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
      expect.objectContaining({ id: 5n, workflowId: 7n, headSha: SHA_A, conclusion: "failure" }),
    ]);
    expect(runs[0]?.headRepositoryFullName).toBe("octo-org/app");
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
  const STORAGE = "https://results-receiver.actions.githubusercontent.com/logs/job-7.txt";

  function serveLog(log: string, seen: { storageAuthorization?: string | null } = {}) {
    mockServer.use(
      http.get(
        `${REPO}/actions/jobs/7/logs`,
        () => new HttpResponse(null, { status: 302, headers: { location: STORAGE } }),
      ),
      http.get(STORAGE, ({ request }) => {
        seen.storageAuthorization = request.headers.get("authorization");
        return new HttpResponse(log, { headers: { "content-type": "text/plain" } });
      }),
    );
  }

  it("follows GitHub's redirect to storage without forwarding our token", async () => {
    const seen: { storageAuthorization?: string | null } = {};
    serveLog("line 1\nError: boom\n", seen);

    const log = await (await repo()).downloadJobLog(7n);

    expect(log).toEqual({ text: "line 1\nError: boom\n", truncated: false });
    expect(seen.storageAuthorization).toBeNull();
  });

  it("keeps only the end of a huge log, starting on a whole line", async () => {
    const lines = Array.from({ length: 2_000 }, (_, i) => `line ${String(i)}`);
    serveLog(`${lines.join("\n")}\nError: the real failure\n`);

    const log = await (await repo()).downloadJobLog(7n, 1_000);

    expect(log.truncated).toBe(true);
    expect(Buffer.byteLength(log.text)).toBeLessThanOrEqual(1_000);
    expect(log.text).toMatch(/^line \d+\n/);
    expect(log.text.endsWith("Error: the real failure\n")).toBe(true);
  });
});

describe("files and comparisons", () => {
  it("compares two commits", async () => {
    let path = "";
    mockServer.use(
      http.get(`${REPO}/compare/:basehead`, ({ request }) => {
        path = decodeURIComponent(new URL(request.url).pathname);
        return HttpResponse.json({
          status: "ahead",
          ahead_by: 1,
          behind_by: 0,
          total_commits: 1,
          commits: [{ sha: SHA_B, commit: { message: "fix: x" }, author: null }],
          files: [
            { filename: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@" },
            { filename: "img.png", status: "added", additions: 0, deletions: 0 },
          ],
        });
      }),
    );

    const comparison = await (await repo()).compareCommits(SHA_A, SHA_B);

    expect(path).toBe(`/repos/octo-org/app/compare/${SHA_A}...${SHA_B}`);
    expect(comparison.commits).toEqual([{ sha: SHA_B, message: "fix: x", authorLogin: null }]);
    expect(comparison.files.map((file) => [file.path, file.patch])).toEqual([
      ["src/a.ts", "@@"],
      ["img.png", null],
    ]);
  });

  function serveFile(body: string | Uint8Array | null, init?: ResponseInit) {
    let seenPath = "";
    let seenAccept: string | null = null;
    mockServer.use(
      http.get(`${REPO}/contents/*`, ({ request }) => {
        // octokit percent-encodes the slashes of {path}; GitHub decodes them.
        seenPath = decodeURIComponent(new URL(request.url).pathname) + new URL(request.url).search;
        seenAccept = request.headers.get("accept");
        return new HttpResponse(body, init);
      }),
    );
    return () => ({ path: seenPath, accept: seenAccept });
  }

  it("reads a text file at a commit, raw, keeping the path's slashes", async () => {
    const seen = serveFile("export const x = 1;\n");

    await expect((await repo()).getFileAtRef("src/lib/x.ts", SHA_A)).resolves.toEqual({
      kind: "text",
      content: "export const x = 1;\n",
      bytes: 20,
    });
    expect(seen().path).toBe(`/repos/octo-org/app/contents/src/lib/x.ts?ref=${SHA_A}`);
    expect(seen().accept).toMatch(/raw/);
  });

  it("recognizes binary files, oversized files, directories and missing files", async () => {
    const client = await repo();

    serveFile(new Uint8Array([0x89, 0x50, 0x00, 0x47]));
    await expect(client.getFileAtRef("img.png", SHA_A)).resolves.toEqual({
      kind: "binary",
      bytes: 4,
    });

    serveFile("x".repeat(2_000));
    await expect(client.getFileAtRef("big.txt", SHA_A, 1_000)).resolves.toEqual({
      kind: "too_large",
      maxBytes: 1_000,
    });

    serveFile("[]", { headers: { "content-type": "application/json; charset=utf-8" } });
    await expect(client.getFileAtRef("src", SHA_A)).resolves.toEqual({ kind: "not_a_file" });

    serveFile(JSON.stringify({ message: "Not Found" }), { status: 404 });
    await expect(client.getFileAtRef("gone.ts", SHA_A)).resolves.toBeNull();
  });

  it("refuses path traversal before calling GitHub", async () => {
    await expect((await repo()).getFileAtRef("../secrets", SHA_A)).rejects.toThrow(GuardError);
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

  it("re-runs a run's failed jobs", async () => {
    let called = false;
    mockServer.use(
      http.post(`${REPO}/actions/runs/99/rerun-failed-jobs`, () => {
        called = true;
        return new HttpResponse(null, { status: 201 });
      }),
    );

    await (await repo()).rerunFailedJobs(99n);

    expect(called).toBe(true);
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

  it.each([
    "pipeheal.yml",
    ".github/workflows/../ci.yml",
    "src/workflow.yml",
    ".github/workflows/a/b.yml",
  ])("refuses to dispatch %s", async (path) => {
    await expect((await repo()).dispatchWorkflow(path, "main", {})).rejects.toThrow(GuardError);
  });
});

describe("commits (Git Data API)", () => {
  function serveGitData() {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const record = async (request: Request) => {
      calls.push({
        method: request.method,
        path: decodeURIComponent(new URL(request.url).pathname),
        body: request.method === "GET" ? null : await request.json(),
      });
    };
    mockServer.use(
      http.get(`${REPO}/git/commits/:sha`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ sha: SHA_A, tree: { sha: "1".repeat(40) } });
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

  const changes = [
    { path: "src/a.ts", content: "export {};\n" },
    { path: "bin/run", content: "#!/bin/sh\n", executable: true },
    { path: "old.ts", delete: true as const },
  ];

  it("creates a pipeheal/* branch with one commit on top of the parent", async () => {
    const calls = serveGitData();

    const result = await (
      await repo()
    ).commitFiles({
      branch: "pipeheal/abc-1",
      parentSha: SHA_A,
      message: "fix: x [PipeHeal]",
      changes,
      createBranch: true,
    });

    expect(result).toEqual({ commitSha: "3".repeat(40) });
    expect(calls).toEqual([
      { method: "GET", path: `/repos/octo-org/app/git/commits/${SHA_A}`, body: null },
      {
        method: "POST",
        path: "/repos/octo-org/app/git/trees",
        body: {
          base_tree: "1".repeat(40),
          tree: [
            { path: "src/a.ts", mode: "100644", type: "blob", content: "export {};\n" },
            { path: "bin/run", mode: "100755", type: "blob", content: "#!/bin/sh\n" },
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

  it("moves an existing pipeheal/* branch forward, never forcing", async () => {
    const calls = serveGitData();

    await (
      await repo()
    ).commitFiles({
      branch: "pipeheal/abc-1",
      parentSha: SHA_A,
      message: "fix: retry",
      changes: [{ path: "src/a.ts", content: "x" }],
      createBranch: false,
    });

    expect(calls.at(-1)).toEqual({
      method: "PATCH",
      path: "/repos/octo-org/app/git/refs/heads/pipeheal/abc-1",
      body: { sha: "3".repeat(40), force: false },
    });
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
    ["path traversal", { changes: [{ path: "../x", content: "x" }] }],
    ["an empty commit", { changes: [] }],
  ])("refuses %s before calling GitHub", async (_label, override) => {
    const calls = serveGitData();

    await expect(
      (await repo()).commitFiles({
        branch: "pipeheal/abc-1",
        parentSha: SHA_A,
        message: "m",
        changes,
        createBranch: true,
        ...override,
      }),
    ).rejects.toThrow(GuardError);
    expect(calls).toEqual([]);
  });
});

describe("pull requests", () => {
  function pull(overrides: Record<string, unknown> = {}) {
    return {
      number: 12,
      html_url: "https://github.com/octo-org/app/pull/12",
      state: "open",
      draft: true,
      merged: false,
      head: { ref: "pipeheal/abc-1", sha: SHA_B, repo: { full_name: "octo-org/app" } },
      base: { ref: "main", repo: { full_name: "octo-org/app" } },
      ...overrides,
    };
  }

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

  it("tells PRs from forks apart", async () => {
    mockServer.use(
      http.get(`${REPO}/pulls/:number`, ({ params }) =>
        HttpResponse.json(
          params.number === "13"
            ? pull({
                number: 13,
                head: { ref: "patch", sha: SHA_B, repo: { full_name: "someone/app" } },
              })
            : pull({ number: 14, head: { ref: "patch", sha: SHA_B, repo: null } }),
        ),
      ),
    );
    const client = await repo();

    await expect(client.getPullRequest(13)).resolves.toMatchObject({ fromFork: true });
    await expect(client.getPullRequest(14)).resolves.toMatchObject({ fromFork: true });
  });

  it("comments and requests reviewers", async () => {
    const seen: unknown[] = [];
    mockServer.use(
      http.post(`${REPO}/issues/12/comments`, async ({ request }) => {
        seen.push(await request.json());
        return HttpResponse.json(
          { id: 900, html_url: "https://github.com/c/900" },
          { status: 201 },
        );
      }),
      http.post(`${REPO}/pulls/12/requested_reviewers`, async ({ request }) => {
        seen.push(await request.json());
        return HttpResponse.json(pull(), { status: 201 });
      }),
    );
    const client = await repo();

    await expect(client.comment(12, "Diagnosis")).resolves.toEqual({
      id: 900n,
      htmlUrl: "https://github.com/c/900",
    });
    await client.requestReviewers(12, ["octo-dev"]);

    expect(seen).toEqual([{ body: "Diagnosis" }, { reviewers: ["octo-dev"] }]);
    await expect(client.comment(12, "x".repeat(65_537))).rejects.toThrow(GuardError);
    await expect(client.requestReviewers(12, ["not a login"])).rejects.toThrow(ZodError);
    await expect(client.requestReviewers(12, [])).rejects.toThrow(ZodError);
  });

  it("has no way to merge (PipeHeal never merges)", async () => {
    const client = await repo();
    expect(Object.keys(client).filter((key) => /merge/i.test(key))).toEqual([]);
  });
});

describe("resilience", () => {
  it("retries a 5xx, then succeeds", async () => {
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
    await expect((await repo({ requestTimeoutMs: 100 })).listWorkflows()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("fails without leaking the installation token", async () => {
    mockServer.use(
      http.get(`${REPO}/actions/workflows`, () =>
        HttpResponse.json({ message: "Resource not accessible by integration" }, { status: 403 }),
      ),
    );

    const error: unknown = await (await repo()).listWorkflows().then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({ status: 403 });
    expect(JSON.stringify(error)).not.toContain(INSTALLATION_TOKEN);
  });
});
