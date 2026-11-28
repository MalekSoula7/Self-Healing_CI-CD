// Needs Postgres and Redis: `docker compose up -d`. The reconciler (SPEC §2.2, P5.3b) against the
// real database and queue, with GitHub on msw. Other test files share the database, so each sweep
// here is narrowed to the test's own attempt.
import { generateKeyPairSync, randomInt, randomUUID } from "node:crypto";
import { forSystem, installations, reconciliation } from "@pipeheal/db";
import { createTestDb } from "@pipeheal/db/testing";
import { createGitHubApp } from "@pipeheal/github";
import { createLogger } from "@pipeheal/shared/logger";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createRedis } from "../redis";
import { reconcile, type ReconcileDeps } from "./reconcile";
import { createSubmissionsQueue } from "./submissions";

const db = createTestDb();
const github = setupServer();
const logger = createLogger({ level: "silent", service: "test" });
const redis = createRedis(process.env.REDIS_URL ?? "redis://localhost:6379", logger);
const queue = createSubmissionsQueue(redis, `test-${randomUUID()}`);
const githubId = () => BigInt(randomInt(1, 2 ** 47));
const sha = () => randomUUID().replaceAll("-", "").padEnd(40, "0");
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
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
  await queue.obliterate({ force: true });
  await queue.close();
  await redis.quit();
  await db.$disconnect();
});

/** A claimed failure and its attempt, then put into the state a test needs. */
async function attempt() {
  const login = `S${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const org = await installations(db, "test").upsert({
    githubAccountId: githubId(),
    login,
    accountType: "ORG",
    installationId: githubId(),
  });
  const system = await forSystem(db, org.id, "test");
  const githubRepoId = githubId();
  const [repo] = await system.repositories.syncInstalled([
    { githubRepoId, fullName: `${login}/app`, defaultBranch: "main" },
  ]);
  if (repo === undefined) throw new Error("test setup: no repository");
  await system.repositories.setEnabled(repo.id, true);
  const ci = githubId();
  await system.workflows.syncInstalled(repo.id, [
    { githubWorkflowId: ci, path: ".github/workflows/ci.yml", name: "CI", selected: true },
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
  const created = await system.attempts.create({
    failureId: failure.id,
    targetSha: failure.headSha,
    failingCheck: "test",
  });
  await db.pipelineFailure.update({ where: { id: failure.id }, data: { status: "HEALING" } });
  const commitSha = sha();
  const branch = `pipeheal/${failure.id.slice(-10)}-1`;
  const set = (data: Parameters<typeof db.healAttempt.update>[0]["data"]) =>
    db.healAttempt.update({ where: { id: created.id }, data });
  const state = async () => {
    const stored = await db.healAttempt.findUniqueOrThrow({ where: { id: created.id } });
    const current = await db.pipelineFailure.findUniqueOrThrow({ where: { id: failure.id } });
    return {
      attempt: stored.status,
      failure: current.status,
      reason: stored.endReason,
      pr: stored.prNumber,
    };
  };
  return {
    org,
    system,
    repoId: repo.id,
    githubRepoId,
    fullName: repo.fullName,
    failureId: failure.id,
    attemptId: created.id,
    commitSha,
    branch,
    ci,
    set,
    state,
  };
}

type Fixture = Awaited<ReturnType<typeof attempt>>;

function deps(f: Fixture, overrides: Partial<ReconcileDeps> = {}): ReconcileDeps {
  const mine = <T extends { orgId: string }>(rows: T[]) => rows.filter((r) => r.orgId === f.org.id);
  return {
    db,
    githubApp: createGitHubApp({ appId: 1234, privateKey, retries: 0 }),
    pacing: {
      record: () => undefined,
      pause: () => Promise.resolve(),
      pausedUntil: () => Promise.resolve(null),
    },
    submissions: queue,
    logger,
    due: async (now) => {
      const due = await reconciliation(db).due(now, 1_000_000);
      return {
        expired: mine(due.expired),
        submissions: mine(due.submissions),
        publishing: mine(due.publishing),
        opened: mine(due.opened),
        unsettled: mine(due.unsettled),
        reruns: mine(due.reruns),
      };
    },
    ...overrides,
  };
}

function mockGitHub(
  f: Fixture,
  options: { runs?: Record<string, unknown>[]; pulls?: "open" | "none" | "other-base" } = {},
) {
  const api = `https://api.github.com/repos/${f.fullName}`;
  const comments: string[] = [];
  const repoRef = { id: Number(f.githubRepoId), full_name: f.fullName };
  const pull = (base: string) => ({
    number: 42,
    html_url: `https://github.com/${f.fullName}/pull/42`,
    state: "open",
    draft: true,
    merged: false,
    head: { ref: f.branch, sha: f.commitSha, repo: repoRef },
    base: { ref: base, repo: repoRef },
  });
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
    http.get(`${api}/actions/runs`, () =>
      HttpResponse.json({ total_count: 0, workflow_runs: options.runs ?? [] }),
    ),
    http.get(`${api}/pulls`, () =>
      HttpResponse.json(
        options.pulls === "none" ? [] : [pull(options.pulls === "other-base" ? "release" : "main")],
      ),
    ),
    http.get(`${api}/pulls/42`, () => HttpResponse.json(pull("main"))),
    http.post(`${api}/issues/42/comments`, async ({ request }) => {
      comments.push(z.object({ body: z.string() }).parse(await request.json()).body);
      return HttpResponse.json({ id: 1, html_url: "https://github.com/x" }, { status: 201 });
    }),
  );
  return { comments };
}

/** As `recordPullRequest` leaves them, `minutes` ago. */
async function opened(f: Fixture, minutes: number) {
  await db.pipelineFailure.update({ where: { id: f.failureId }, data: { status: "PR_OPENED" } });
  await f.set({
    status: "PR_OPENED",
    branch: f.branch,
    commitSha: f.commitSha,
    prNumber: 42,
    prOpenedAt: ago(minutes),
  });
}

describe("reconcile: attempts with a runner", () => {
  it("fails a healer that never started", async () => {
    const f = await attempt();
    await f.set({ dispatchedAt: ago(16) });

    await reconcile(deps(f));

    await expect(f.state()).resolves.toMatchObject({
      attempt: "FAILED",
      failure: "FAILED",
      reason: "the healer never started",
    });
  });

  it("settles a failure whose attempt ended without a pull request", async () => {
    const f = await attempt();
    await f.set({ status: "GAVE_UP" });

    await reconcile(deps(f));

    await expect(f.state()).resolves.toMatchObject({ failure: "NEEDS_HUMAN" });
  });
});

describe("reconcile: lost jobs", () => {
  it.each([
    ["VALIDATING", "validate"],
    ["VALIDATED", "publish"],
  ] as const)("queues a lost %s attempt's job again", async (status, name) => {
    const f = await attempt();
    await f.set({ status, updatedAt: ago(11) });

    await reconcile(deps(f));

    await expect(queue.getJob(`${name}-${f.attemptId}`)).resolves.toBeDefined();
    await expect(f.state()).resolves.toMatchObject({ attempt: status });
  });

  it("leaves a job that is still queued, however old", async () => {
    const f = await attempt();
    await f.set({ status: "VALIDATING", updatedAt: ago(3 * 60) });
    await queue.add("validate", {}, { jobId: `validate-${f.attemptId}` });

    await reconcile(deps(f));

    await expect(f.state()).resolves.toMatchObject({ attempt: "VALIDATING" });
  });

  it.each([
    ["VALIDATING", "REJECTED"],
    ["VALIDATED", "FAILED"],
  ] as const)("gives up on a %s attempt after 2 hours", async (status, ended) => {
    const f = await attempt();
    // What the runner uploaded: a VALIDATING attempt always has it.
    await db.attemptSubmission.create({
      data: {
        orgId: f.org.id,
        attemptId: f.attemptId,
        requestHash: "e".repeat(64),
        files: [],
        checks: [],
        afterTests: { available: false, reason: "no report" },
      },
    });
    await f.set({ status, updatedAt: ago(2 * 60 + 1) });

    await reconcile(deps(f));

    await expect(f.state()).resolves.toMatchObject({ attempt: ended, failure: "FAILED" });
  });
});

describe("reconcile: interrupted publishing", () => {
  const publishing = (f: Fixture, commitSha: string | null = f.commitSha) =>
    f.set({ status: "PUBLISHING", branch: f.branch, commitSha, updatedAt: ago(16) });

  it("records the pull request GitHub has for the branch", async () => {
    const f = await attempt();
    await publishing(f);
    mockGitHub(f);

    await reconcile(deps(f));

    await expect(f.state()).resolves.toMatchObject({
      attempt: "PR_OPENED",
      failure: "PR_OPENED",
      pr: 42,
    });
  });

  it.each(["none", "other-base"] as const)(
    "fails without its own pull request (%s)",
    async (pulls) => {
      const f = await attempt();
      await publishing(f);
      mockGitHub(f, { pulls });

      await reconcile(deps(f));

      await expect(f.state()).resolves.toMatchObject({
        attempt: "FAILED",
        reason: "publishing was interrupted before the pull request was opened",
      });
    },
  );

  it("fails without asking GitHub when no commit was recorded", async () => {
    const f = await attempt();
    await publishing(f, null);

    await reconcile(deps(f));

    await expect(f.state()).resolves.toMatchObject({ attempt: "FAILED" });
  });
});

describe("reconcile: verification timeouts", () => {
  const run = (f: Fixture, status: string, conclusion: string | null) => ({
    id: Number(githubId()),
    run_attempt: 1,
    workflow_id: Number(f.ci),
    name: "CI",
    path: ".github/workflows/ci.yml",
    head_sha: f.commitSha,
    head_branch: f.branch,
    event: "pull_request",
    status,
    conclusion,
    html_url: "https://github.com/x/y/actions/runs/1",
    repository: { id: Number(f.githubRepoId), full_name: f.fullName },
    head_repository: { id: Number(f.githubRepoId), full_name: f.fullName },
  });

  it("verifies a pull request whose webhook was missed", async () => {
    const f = await attempt();
    await opened(f, 11);
    mockGitHub(f, { runs: [run(f, "completed", "success")] });

    await reconcile(deps(f));

    await expect(f.state()).resolves.toMatchObject({ attempt: "VERIFIED", failure: "VERIFIED" });
  });

  it("waits within the timeouts", async () => {
    const noRuns = await attempt();
    await opened(noRuns, 20);
    mockGitHub(noRuns);
    await reconcile(deps(noRuns));
    await expect(noRuns.state()).resolves.toMatchObject({ attempt: "PR_OPENED" });

    const running = await attempt();
    await opened(running, 5 * 60);
    mockGitHub(running, { runs: [run(running, "in_progress", null)] });
    await reconcile(deps(running));
    await expect(running.state()).resolves.toMatchObject({ attempt: "PR_OPENED" });
  });

  it.each([
    [31, null, "no CI run of a watched workflow started on the pull request"],
    [31, "skipped", "the workflow that failed didn't run and pass on the pull request"],
    [6 * 60 + 1, "running", "CI didn't finish within 6 hours"],
  ])("is UNVERIFIED after %i minutes (%s), with one comment", async (minutes, kind, reason) => {
    const f = await attempt();
    await opened(f, minutes);
    const runs =
      kind === null
        ? []
        : [kind === "running" ? run(f, "in_progress", null) : run(f, "completed", "skipped")];
    const { comments } = mockGitHub(f, { runs });

    await reconcile(deps(f));
    await reconcile(deps(f));

    await expect(f.state()).resolves.toMatchObject({
      attempt: "UNVERIFIED",
      failure: "UNVERIFIED",
      reason,
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain(reason);
  });

  it("records a disabled repository as UNVERIFIED without calling GitHub", async () => {
    const f = await attempt();
    await opened(f, 11);
    await f.system.repositories.setEnabled(f.repoId, false);

    await reconcile(deps(f));

    await expect(f.state()).resolves.toMatchObject({ attempt: "UNVERIFIED" });
  });

  it("skips an installation GitHub is rate-limiting", async () => {
    const f = await attempt();
    await opened(f, 60);

    await reconcile(
      deps(f, {
        pacing: {
          record: () => undefined,
          pause: () => Promise.resolve(),
          pausedUntil: () => Promise.resolve(new Date(Date.now() + 60_000)),
        },
      }),
    );

    await expect(f.state()).resolves.toMatchObject({ attempt: "PR_OPENED" });
  });
});
