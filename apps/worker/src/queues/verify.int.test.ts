// Needs Postgres: `docker compose up -d`. Verification (SPEC §9.1, P5.3a): a `workflow_run` on
// PipeHeal's branch, against the real database with GitHub on msw.
import { generateKeyPairSync, randomInt, randomUUID } from "node:crypto";
import { forSystem, installations } from "@pipeheal/db";
import { createTestDb } from "@pipeheal/db/testing";
import { createGitHubApp, workflowRunEventSchema } from "@pipeheal/github";
import { createLogger } from "@pipeheal/shared/logger";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { WebhookProcessorDeps } from "./webhooks";
import { processWorkflowRunEvent } from "./workflow-runs";

const db = createTestDb();
const github = setupServer();
const logger = createLogger({ level: "silent", service: "test" });
const githubId = () => BigInt(randomInt(1, 2 ** 47));
const sha = () => randomUUID().replaceAll("-", "").padEnd(40, "0");
const STORAGE = "https://productionresults.blob.core.windows.net";
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

beforeAll(() => {
  github.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  github.resetHandlers();
});
afterAll(async () => {
  github.close();
  await db.$disconnect();
});

const unused = () => Promise.reject(new Error("no failure job is expected"));
const deps = (): WebhookProcessorDeps => ({
  db,
  githubApp: createGitHubApp({ appId: 1234, privateKey, retries: 0 }),
  logger,
  pacing: {
    record: () => undefined,
    pause: () => Promise.resolve(),
    pausedUntil: () => Promise.resolve(null),
  },
  failureJobs: {
    scheduleWindowClose: unused,
    enqueueTriage: unused,
    enqueueRecentChanges: unused,
    enqueueFlakyCheck: unused,
    enqueuePolicyFile: unused,
    enqueueDispatch: unused,
  },
});

/** An attempt with an open pull request on PipeHeal's commit; CI (watched) failed originally. */
async function opened() {
  const login = `C${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const installationId = githubId();
  const org = await installations(db, "test").upsert({
    githubAccountId: githubId(),
    login,
    accountType: "ORG",
    installationId,
  });
  const system = await forSystem(db, org.id, "test");
  const githubRepoId = githubId();
  const [repo] = await system.repositories.syncInstalled([
    { githubRepoId, fullName: `${login}/app`, defaultBranch: "main" },
  ]);
  if (repo === undefined) throw new Error("test setup: no repository");
  await system.repositories.setEnabled(repo.id, true);
  const [ci, lint, deploy] = [githubId(), githubId(), githubId()];
  await system.workflows.syncInstalled(repo.id, [
    { githubWorkflowId: ci, path: ".github/workflows/ci.yml", name: "CI", selected: true },
    { githubWorkflowId: lint, path: ".github/workflows/lint.yml", name: "Lint", selected: true },
    { githubWorkflowId: deploy, path: ".github/workflows/deploy.yml", name: "Deploy" },
  ]);
  const { failure } = await system.failures.recordFailedRun(repo.id, {
    headSha: sha(),
    headBranch: "main",
    runId: githubId(),
    runAttempt: 1,
    workflowId: ci,
    workflowName: "CI",
    workflowPath: ".github/workflows/ci.yml",
    conclusion: "failure",
    htmlUrl: null,
    jobs: [{ githubJobId: githubId(), name: "check", failedStep: "Test", htmlUrl: null }],
  });
  const attempt = await system.attempts.create({
    failureId: failure.id,
    targetSha: failure.headSha,
    failingCheck: "test",
  });
  const commitSha = sha();
  const branch = `pipeheal/${failure.id.slice(-10)}-1`;
  await db.healAttempt.update({ where: { id: attempt.id }, data: { status: "VALIDATED" } });
  await system.attempts.claimPublish(attempt.id, branch);
  await system.attempts.recordCommit(attempt.id, commitSha);
  await system.attempts.recordPullRequest(attempt.id, {
    number: 42,
    url: `https://github.com/${login}/app/pull/42`,
    draft: false,
  });
  return {
    installationId,
    system,
    repoId: repo.id,
    githubRepoId,
    fullName: repo.fullName,
    failureId: failure.id,
    attemptId: attempt.id,
    commitSha,
    branch,
    ci,
    lint,
    deploy,
  };
}

type Fixture = Awaited<ReturnType<typeof opened>>;

function runJson(f: Fixture, overrides: Record<string, unknown> = {}) {
  const repository = { id: Number(f.githubRepoId), full_name: f.fullName };
  const id = Number(githubId());
  return {
    id,
    run_attempt: 1,
    workflow_id: Number(f.ci),
    name: "CI",
    path: ".github/workflows/ci.yml",
    head_sha: f.commitSha,
    head_branch: f.branch,
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    html_url: `https://github.com/${f.fullName}/actions/runs/${String(id)}`,
    repository,
    head_repository: repository,
    ...overrides,
  };
}

function event(f: Fixture, run: Record<string, unknown> = {}) {
  return workflowRunEventSchema.parse({
    action: "completed",
    installation: { id: Number(f.installationId) },
    repository: { id: Number(f.githubRepoId), full_name: f.fullName },
    workflow_run: runJson(f, run),
  });
}

/** GitHub for one repository: the commit's runs, their failed jobs, the PR and its comments. */
function mockGitHub(
  f: Fixture,
  options: {
    runs: Record<string, unknown>[];
    head?: string;
    state?: "open" | "closed";
    refuseComment?: boolean;
    refuseJobs?: boolean;
    /** The conclusion of the originally failed job, when not the run's own. */
    job?: string;
    /** The failed job's log, and whether GitHub accepts the healer dispatch. */
    log?: string;
    refuseDispatch?: boolean;
  },
) {
  const api = `https://api.github.com/repos/${f.fullName}`;
  const comments: string[] = [];
  const listed: string[] = [];
  const dispatched: unknown[] = [];
  const repoRef = { id: Number(f.githubRepoId), full_name: f.fullName };
  const pull = {
    number: 42,
    html_url: `https://github.com/${f.fullName}/pull/42`,
    state: options.state ?? "open",
    draft: false,
    merged: false,
    head: { ref: f.branch, sha: options.head ?? f.commitSha, repo: repoRef },
    base: { ref: "main", repo: repoRef },
  };
  github.use(
    http.post("https://api.github.com/app/installations/:id/access_tokens", async ({ request }) => {
      const text = await request.text();
      const token = {
        token: "ghs_testInstallationToken00000000000000",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      };
      if (text === "") return HttpResponse.json(token);
      const scope = z
        .object({
          repository_ids: z.array(z.number()),
          permissions: z.record(z.string(), z.string()),
        })
        .parse(JSON.parse(text));
      return HttpResponse.json({
        ...token,
        repository_selection: "selected",
        permissions: { ...scope.permissions, metadata: "read" },
        repositories: scope.repository_ids.map((id) => ({ id })),
      });
    }),
    http.get(`${api}/actions/runs`, ({ request }) => {
      listed.push(new URL(request.url).searchParams.get("head_sha") ?? "");
      return HttpResponse.json({ total_count: options.runs.length, workflow_runs: options.runs });
    }),
    http.get(`${api}/actions/runs/:runId/attempts/:attempt/jobs`, ({ params }) => {
      if (options.refuseJobs === true) {
        return HttpResponse.json({ message: "Not Found" }, { status: 404 });
      }
      const run = options.runs.find((candidate) => candidate.id === Number(params.runId));
      const conclusion = options.job ?? run?.conclusion ?? "success";
      return HttpResponse.json({
        total_count: 1,
        jobs: [
          {
            id: 7001,
            run_id: Number(params.runId),
            run_attempt: Number(params.attempt),
            name: "check",
            status: "completed",
            conclusion,
            html_url: null,
            steps: [{ name: "Test", number: 1, conclusion }],
          },
        ],
      });
    }),
    http.get(`${api}/pulls/42`, () => HttpResponse.json(pull)),
    http.get(
      `${api}/actions/jobs/7001/logs`,
      () =>
        new HttpResponse(null, {
          status: 302,
          headers: { location: `${STORAGE}/log.txt?sig=x` },
        }),
    ),
    http.get(`${STORAGE}/log.txt`, () => new HttpResponse(options.log ?? "boom")),
    http.post(`${api}/actions/workflows/pipeheal.yml/dispatches`, async ({ request }) => {
      dispatched.push(await request.json());
      return options.refuseDispatch === true
        ? HttpResponse.json({ message: "no workflow" }, { status: 404 })
        : HttpResponse.json({ workflow_run_id: 555 });
    }),
    http.post(`${api}/issues/42/comments`, async ({ request }) => {
      if (options.refuseComment === true) {
        return HttpResponse.json({ message: "Forbidden" }, { status: 403 });
      }
      comments.push(z.object({ body: z.string() }).parse(await request.json()).body);
      return HttpResponse.json({ id: 1, html_url: "https://github.com/x" }, { status: 201 });
    }),
  );
  return { comments, listed, dispatched };
}

async function state(f: Fixture) {
  const attempt = await db.healAttempt.findUniqueOrThrow({ where: { id: f.attemptId } });
  const failure = await db.pipelineFailure.findUniqueOrThrow({ where: { id: f.failureId } });
  return { attempt: attempt.status, failure: failure.status, reason: attempt.endReason };
}

const UNCHANGED = { attempt: "PR_OPENED", failure: "PR_OPENED", reason: null };

describe("workflow_run on PipeHeal's branch (P5.3a)", () => {
  it("marks the attempt VERIFIED when CI passes on PipeHeal's commit, without a comment", async () => {
    const f = await opened();
    const { comments, listed } = mockGitHub(f, {
      runs: [runJson(f), runJson(f, { workflow_id: Number(f.lint) })],
    });

    await processWorkflowRunEvent(deps(), event(f), logger);

    await expect(state(f)).resolves.toMatchObject({ attempt: "VERIFIED", failure: "VERIFIED" });
    expect(listed).toEqual([f.commitSha]);
    expect(comments).toEqual([]);
  });

  it("hands a red run to a person with one comment, however often it is delivered", async () => {
    const f = await opened();
    const { comments } = mockGitHub(f, { runs: [runJson(f, { conclusion: "failure" })] });

    await processWorkflowRunEvent(deps(), event(f, { conclusion: "failure" }), logger);
    await processWorkflowRunEvent(deps(), event(f, { conclusion: "failure" }), logger);

    await expect(state(f)).resolves.toEqual({
      attempt: "CI_FAILED",
      failure: "NEEDS_HUMAN",
      reason: "CI failed on PipeHeal's commit",
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("`CI` / `check` / `Test`");
  });

  it("waits while another watched run of the commit is still going", async () => {
    const f = await opened();
    mockGitHub(f, {
      runs: [
        runJson(f),
        runJson(f, { workflow_id: Number(f.lint), status: "in_progress", conclusion: null }),
      ],
    });

    await processWorkflowRunEvent(deps(), event(f), logger);

    await expect(state(f)).resolves.toEqual(UNCHANGED);
  });

  it("doesn't call it verified when only another workflow ran", async () => {
    const f = await opened();
    mockGitHub(f, { runs: [runJson(f, { workflow_id: Number(f.lint) })] });

    await processWorkflowRunEvent(deps(), event(f, { workflow_id: Number(f.lint) }), logger);

    await expect(state(f)).resolves.toEqual(UNCHANGED);
  });

  it("counts only watched runs of this repository's own code on PipeHeal's branch", async () => {
    const f = await opened();
    const red = { conclusion: "failure" };
    mockGitHub(f, {
      runs: [
        runJson(f),
        runJson(f, { ...red, workflow_id: Number(f.deploy) }),
        runJson(f, { ...red, head_branch: "someone/else" }),
        runJson(f, { ...red, head_repository: { id: 1, full_name: "someone/app" } }),
        runJson(f, { ...red, event: "pull_request_target" }),
        runJson(f, { ...red, path: ".github/workflows/pipeheal.yml" }),
      ],
    });

    await processWorkflowRunEvent(deps(), event(f), logger);

    await expect(state(f)).resolves.toMatchObject({ attempt: "VERIFIED" });
  });

  // No GitHub mocks: any call would fail the test.
  it.each<[string, (f: Fixture) => Record<string, unknown>]>([
    ["another commit on the branch", () => ({ head_sha: sha() })],
    ["PipeHeal's commit on another branch", () => ({ head_branch: "pipeheal/other-1" })],
    ["a fork's run with PipeHeal's commit and branch", () => ({ head_repository: null })],
    ["an untrusted trigger", () => ({ event: "pull_request_target" })],
  ])("ignores %s without calling GitHub", async (_case, run) => {
    const f = await opened();

    await processWorkflowRunEvent(deps(), event(f, run(f)), logger);

    await expect(state(f)).resolves.toEqual(UNCHANGED);
  });

  it("isn't verified when the job that failed was skipped in a passing run", async () => {
    const f = await opened();
    mockGitHub(f, { runs: [runJson(f)], job: "skipped" });

    await processWorkflowRunEvent(deps(), event(f), logger);

    await expect(state(f)).resolves.toEqual(UNCHANGED);
  });

  it("takes no proof from a manually dispatched run", async () => {
    const f = await opened();
    mockGitHub(f, { runs: [runJson(f, { event: "workflow_dispatch" })] });

    await processWorkflowRunEvent(deps(), event(f), logger);

    await expect(state(f)).resolves.toEqual(UNCHANGED);
  });

  it("comments on the first failure only, however the re-runs flip", async () => {
    const f = await opened();
    const run = runJson(f);
    const comments: string[] = [];
    for (const [attempt, conclusion] of [
      [1, "failure"],
      [2, "success"],
      [3, "failure"],
    ] as const) {
      const mock = mockGitHub(f, { runs: [{ ...run, run_attempt: attempt, conclusion }] });
      await processWorkflowRunEvent(deps(), event(f), logger);
      comments.push(...mock.comments);
    }

    expect(comments).toHaveLength(1);
    await expect(state(f)).resolves.toMatchObject({ attempt: "CI_FAILED" });
  });

  it("records a red run even when its jobs can't be listed", async () => {
    const f = await opened();
    const { comments } = mockGitHub(f, {
      runs: [runJson(f, { conclusion: "failure" })],
      refuseJobs: true,
    });

    await processWorkflowRunEvent(deps(), event(f), logger);

    await expect(state(f)).resolves.toMatchObject({ attempt: "CI_FAILED" });
    expect(comments[0]).toContain("`CI` / `(no failed job)`");
  });

  it("is UNVERIFIED, without a comment, when someone else pushed to the branch", async () => {
    const f = await opened();
    const { comments } = mockGitHub(f, {
      runs: [runJson(f, { conclusion: "failure" })],
      head: sha(),
    });

    await processWorkflowRunEvent(deps(), event(f), logger);

    await expect(state(f)).resolves.toEqual({
      attempt: "UNVERIFIED",
      failure: "UNVERIFIED",
      reason: "someone else pushed to the pull request's branch",
    });
    expect(comments).toEqual([]);
  });

  it("records a red run on a closed pull request without commenting", async () => {
    const f = await opened();
    const { comments } = mockGitHub(f, {
      runs: [runJson(f, { conclusion: "failure" })],
      state: "closed",
    });

    await processWorkflowRunEvent(deps(), event(f), logger);

    await expect(state(f)).resolves.toMatchObject({ attempt: "CI_FAILED" });
    expect(comments).toEqual([]);
  });

  it("keeps the verdict when the comment can't be posted", async () => {
    const f = await opened();
    mockGitHub(f, { runs: [runJson(f, { conclusion: "failure" })], refuseComment: true });

    await processWorkflowRunEvent(deps(), event(f), logger);

    await expect(state(f)).resolves.toMatchObject({ failure: "NEEDS_HUMAN" });
  });

  it("does nothing for a disabled repository", async () => {
    const f = await opened();
    await f.system.repositories.setEnabled(f.repoId, false);

    await processWorkflowRunEvent(deps(), event(f), logger);

    await expect(state(f)).resolves.toEqual(UNCHANGED);
  });
});

describe("the retry after red CI (P5.3d)", () => {
  const token = `ghp_${"a1B2".repeat(9)}`;
  const lintLog = [
    "> app@1.0.0 lint",
    "> eslint .",
    "",
    "/home/runner/work/app/app/src/a.ts",
    "  1:7  error  'x' is assigned a value but never used  @typescript-eslint/no-unused-vars",
    "",
    "1 problem (1 error, 0 warnings)",
    `token=${token}`,
    "##[error]Process completed with exit code 1.",
  ].join("\n");

  async function red() {
    const f = await opened();
    await db.repository.update({
      where: { id: f.repoId },
      data: { commands: { lint: ["pnpm", "lint"], test: ["pnpm", "test"] } },
    });
    return f;
  }
  const attempts = (f: Fixture) =>
    db.healAttempt.findMany({ where: { failureId: f.failureId }, orderBy: { attemptNo: "asc" } });
  const run = (f: Fixture, mock: Parameters<typeof mockGitHub>[1], enabled = true) => {
    const github_ = mockGitHub(f, mock);
    return processWorkflowRunEvent(
      { ...deps(), dispatchEnabled: enabled },
      event(f, { conclusion: "failure" }),
      logger,
    ).then(() => github_);
  };

  it("dispatches a second attempt on PipeHeal's commit with the redacted new failure", async () => {
    const f = await red();

    const { comments, dispatched } = await run(f, {
      runs: [runJson(f, { conclusion: "failure" })],
      log: lintLog,
    });

    const [first, second] = await attempts(f);
    expect(first?.status).toBe("CI_FAILED");
    expect(second).toMatchObject({
      attemptNo: 2,
      status: "DISPATCHED",
      targetSha: f.commitSha,
      retryOfId: first?.id,
      failingCheck: "lint",
      dispatchRunId: 555n,
    });
    const feedback = JSON.stringify(second?.feedback);
    expect(feedback).toContain("no-unused-vars");
    expect(feedback).not.toContain(token);
    expect(dispatched).toMatchObject([{ inputs: { job_id: second?.id, target_sha: f.commitSha } }]);
    await expect(
      db.pipelineFailure.findUniqueOrThrow({ where: { id: f.failureId } }),
    ).resolves.toMatchObject({ status: "HEALING" });
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("PipeHeal is trying once more");
  });

  it("leaves it to a person when dispatching is off (HEAL_DISPATCH)", async () => {
    const f = await red();

    const { comments, dispatched } = await run(
      f,
      { runs: [runJson(f, { conclusion: "failure" })] },
      false,
    );

    expect(await attempts(f)).toHaveLength(1);
    expect(dispatched).toEqual([]);
    expect(comments[0]).toContain("Someone needs to take it from here.");
  });

  it("leaves it to a person at the attempt cap", async () => {
    const f = await red();
    await f.system.policies.save("REPO", f.repoId, { limits: { maxAttemptsPerFailure: 1 } });

    const { dispatched } = await run(f, { runs: [runJson(f, { conclusion: "failure" })] });

    expect(await attempts(f)).toHaveLength(1);
    expect(dispatched).toEqual([]);
  });

  it("leaves it to a person when GitHub refuses the dispatch", async () => {
    const f = await red();

    const { comments } = await run(f, {
      runs: [runJson(f, { conclusion: "failure" })],
      refuseDispatch: true,
    });

    const [, second] = await attempts(f);
    expect(second?.status).toBe("FAILED");
    await expect(
      db.pipelineFailure.findUniqueOrThrow({ where: { id: f.failureId } }),
    ).resolves.toMatchObject({ status: "NEEDS_HUMAN" });
    expect(comments[0]).toContain("Someone needs to take it from here.");
  });
});
