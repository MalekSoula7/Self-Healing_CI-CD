// Needs Postgres and Redis: `docker compose up -d`. GitHub (and its log storage) is msw, started
// here: integration tests have no shared msw server. Real BullMQ, on a unique key prefix.
import { generateKeyPairSync, randomInt, randomUUID } from "node:crypto";
import { forSystem, installations } from "@pipeheal/db";
import { createTestDb } from "@pipeheal/db/testing";
import { createGitHubApp } from "@pipeheal/github";
import { createLogger } from "@pipeheal/shared/logger";
import { testRedisUrl } from "@pipeheal/shared/testing";
import { UnrecoverableError } from "bullmq";
import { Redis } from "ioredis";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { RateLimitedError, type InstallationPacing } from "../pacing";
import {
  createFailuresQueue,
  failureJobs,
  processFailuresJob,
  type FailureJobs,
  type FailuresDeps,
  type FailuresQueue,
} from "./failures";
import type { FailureTarget } from "./triage";

const db = createTestDb();
const github = setupServer();
const logger = createLogger({ level: "silent", service: "test" });
const prefix = `test-${randomUUID()}`;
let connection: Redis;
let queue: FailuresQueue;

beforeAll(() => {
  github.listen({ onUnhandledRequest: "error" });
  connection = new Redis(testRedisUrl(), { maxRetriesPerRequest: null });
  queue = createFailuresQueue(connection, logger, prefix);
});
afterEach(() => {
  github.resetHandlers();
});
afterAll(async () => {
  github.close();
  await queue.obliterate({ force: true });
  await queue.close();
  connection.disconnect();
  await db.$disconnect();
});

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const STORAGE = "https://results-receiver.actions.githubusercontent.com";
// Built at runtime: nothing secret-shaped is committed.
const PLANTED_TOKEN = "gh" + "p_" + "Zq8".repeat(12);

function githubId(): bigint {
  return BigInt(randomInt(1, 2 ** 47));
}

const openPacing: InstallationPacing = {
  record: () => undefined,
  pause: () => Promise.resolve(),
  pausedUntil: () => Promise.resolve(null),
};

function deps(overrides: Partial<FailuresDeps> = {}) {
  const triaged: { target: FailureTarget; key: string | undefined }[] = [];
  const jobs: FailureJobs = {
    scheduleWindowClose: () => Promise.resolve(),
    enqueueTriage: (target, key) => {
      triaged.push({ target, key });
      return Promise.resolve();
    },
  };
  const all: FailuresDeps = {
    db,
    logger,
    githubApp: createGitHubApp({ appId: 1234, privateKey, retries: 0 }),
    pacing: openPacing,
    jobs,
    ...overrides,
  };
  return { deps: all, triaged };
}

/** An org with a repo and a failure with one failed job; its window still open. */
async function openFailure() {
  const login = `org-${randomUUID().slice(0, 8)}`;
  const installationId = githubId();
  const org = await installations(db, "test").upsert({
    githubAccountId: githubId(),
    login,
    accountType: "ORG",
    installationId,
  });
  const system = await forSystem(db, org.id, "test");
  const [repo] = await system.repositories.syncInstalled([
    { githubRepoId: githubId(), fullName: `${login}/app`, defaultBranch: "main" },
  ]);
  if (repo === undefined) throw new Error("test setup: no repository");
  const githubJobId = githubId();
  const { failure, run } = await system.failures.recordFailedRun(repo.id, {
    headSha: "a".repeat(40),
    headBranch: "main",
    runId: githubId(),
    runAttempt: 1,
    workflowId: 1n,
    workflowName: "CI",
    workflowPath: ".github/workflows/ci.yml",
    conclusion: "failure",
    htmlUrl: null,
    jobs: [{ githubJobId, name: "check", failedStep: "Typecheck", htmlUrl: null }],
  });
  const target: FailureTarget = { orgId: org.id, failureId: failure.id, installationId };
  return { target, repoFullName: repo.fullName, githubJobId, failedRunId: run.id };
}

function mockToken() {
  github.use(
    http.post("https://api.github.com/app/installations/:id/access_tokens", () =>
      HttpResponse.json(
        {
          token: "ghs_testInstallationToken00000000000000",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
        { status: 201 },
      ),
    ),
  );
}

/** GitHub's log endpoint redirecting to its log storage, which serves `body`. */
function mockLog(fullName: string, githubJobId: bigint, body: string) {
  const path = `/logs/${String(githubJobId)}.txt`;
  github.use(
    http.get(
      `https://api.github.com/repos/${fullName}/actions/jobs/${String(githubJobId)}/logs`,
      () =>
        new HttpResponse(null, { status: 302, headers: { location: `${STORAGE}${path}?sig=x` } }),
    ),
    http.get(`${STORAGE}${path}`, () => new HttpResponse(body)),
  );
}

async function jobOf(failedRunId: string) {
  return db.failedJob.findFirstOrThrow({ where: { failedRunId } });
}

const LOG = [
  "2026-09-28T23:22:10.1102345Z ##[group]Run npm run typecheck",
  `2026-09-28T23:22:10.1112345Z + export GITHUB_TOKEN=${PLANTED_TOKEN}`,
  "2026-09-28T23:22:10.1122345Z ##[endgroup]",
  "2026-09-28T23:22:12.1101234Z \u001b[96msrc/receipt.ts\u001b[0m:1:25 - error TS2305: Module '\"./cart\"' has no exported member 'lineTotal'.",
  "2026-09-28T23:22:12.1112345Z ##[error]Process completed with exit code 2.",
  // Post-job steps follow the failed step in the job log: not part of the error window.
  "2026-09-28T23:22:12.2201234Z Post job cleanup.",
  "2026-09-28T23:22:12.2212345Z Removing credentials config '/home/runner/work/_temp/git-credentials.config'",
  "2026-09-28T23:22:12.2223456Z Cleaning up orphan processes",
  "",
].join("\n");

describe("close-window job", () => {
  it("closes the collection window, then queues the failure's triage", async () => {
    const { target } = await openFailure();
    const { deps: d, triaged } = deps();

    await processFailuresJob(
      { name: "close-window", data: { ...target, installationId: String(target.installationId) } },
      d,
    );

    const closed = await db.pipelineFailure.findUniqueOrThrow({ where: { id: target.failureId } });
    expect(closed.windowClosedAt).toBeInstanceOf(Date);
    expect(triaged).toEqual([{ target, key: undefined }]);
  });

  it("does nothing when the failure (or its organization) is gone", async () => {
    const { target } = await openFailure();
    const { deps: d, triaged } = deps();

    for (const data of [
      { ...target, failureId: randomUUID() },
      { ...target, orgId: randomUUID() },
    ]) {
      await expect(
        processFailuresJob(
          { name: "close-window", data: { ...data, installationId: String(data.installationId) } },
          d,
        ),
      ).resolves.toBeUndefined();
    }
    expect(triaged).toEqual([]);
  });

  it("refuses unknown jobs and malformed data without retrying", async () => {
    await expect(processFailuresJob({ name: "heal", data: {} }, deps().deps)).rejects.toThrow(
      UnrecoverableError,
    );
    await expect(
      processFailuresJob({ name: "triage", data: { orgId: "x" } }, deps().deps),
    ).rejects.toThrow();
  });
});

describe("triage job (SPEC §6.2 steps 1-3)", () => {
  function triageJob(target: FailureTarget) {
    return { name: "triage", data: { ...target, installationId: String(target.installationId) } };
  }

  it("stores each failed job's log, cleaned and redacted, as its error window", async () => {
    const { target, repoFullName, githubJobId, failedRunId } = await openFailure();
    mockToken();
    mockLog(repoFullName, githubJobId, LOG);

    await processFailuresJob(triageJob(target), deps().deps);

    const job = await jobOf(failedRunId);
    expect(job.errorWindow).toBe(
      [
        "Run npm run typecheck",
        "+ export GITHUB_TOKEN=[redacted:github-token]",
        "src/receipt.ts:1:25 - error TS2305: Module '\"./cart\"' has no exported member 'lineTotal'.",
        "##[error]Process completed with exit code 2.",
      ].join("\n"),
    );
    const audit = await db.auditLog.findFirstOrThrow({
      where: { orgId: target.orgId, action: "failure.job_triaged" },
    });
    expect(audit.metadata).toMatchObject({ redactions: { "github-token": 1 } });
    const asText = (value: unknown) =>
      JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? String(v) : v));
    const everything =
      asText(await db.failedJob.findMany({ where: { failedRunId } })) +
      asText(await db.auditLog.findMany({ where: { orgId: target.orgId } }));
    expect(everything).not.toContain(PLANTED_TOKEN);
  });

  it("keeps only the end of a long log, and doesn't fetch a job it already triaged", async () => {
    const { target, repoFullName, githubJobId, failedRunId } = await openFailure();
    mockToken();
    const lines = Array.from({ length: 1_000 }, (_, i) => `step output ${String(i)}`);
    mockLog(repoFullName, githubJobId, [...lines, "Error: the real failure"].join("\n"));
    await processFailuresJob(triageJob(target), deps().deps);

    const window = (await jobOf(failedRunId)).errorWindow ?? "";
    expect(window.split("\n")).toHaveLength(300);
    expect(window.endsWith("Error: the real failure")).toBe(true);

    // No GitHub mocks now: a second fetch would fail the job.
    github.resetHandlers();
    await expect(processFailuresJob(triageJob(target), deps().deps)).resolves.toBeUndefined();
  });

  it("records an empty window when GitHub no longer has the log", async () => {
    const { target, repoFullName, githubJobId, failedRunId } = await openFailure();
    mockToken();
    github.use(
      http.get(
        `https://api.github.com/repos/${repoFullName}/actions/jobs/${String(githubJobId)}/logs`,
        () => HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
    );

    await processFailuresJob(triageJob(target), deps().deps);

    expect((await jobOf(failedRunId)).errorWindow).toBe("");
  });

  it("waits, without calling GitHub, while the installation is paused", async () => {
    const { target, failedRunId } = await openFailure();
    const until = new Date(Date.now() + 60_000);
    const paused = { ...openPacing, pausedUntil: () => Promise.resolve(until) };

    await expect(
      processFailuresJob(triageJob(target), deps({ pacing: paused }).deps),
    ).rejects.toMatchObject({ name: "RateLimitedError", until });
    expect((await jobOf(failedRunId)).errorWindow).toBeNull();
  });

  it("pauses the installation when GitHub rate-limits the log download", async () => {
    const { target, repoFullName, githubJobId, failedRunId } = await openFailure();
    mockToken();
    const reset = Math.floor(Date.now() / 1000) + 900;
    github.use(
      http.get(
        `https://api.github.com/repos/${repoFullName}/actions/jobs/${String(githubJobId)}/logs`,
        () =>
          HttpResponse.json(
            { message: "API rate limit exceeded" },
            {
              status: 403,
              headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
            },
          ),
      ),
    );
    const pauses: Date[] = [];
    const pacing: InstallationPacing = {
      ...openPacing,
      pause: (_id, until) => {
        pauses.push(until);
        return Promise.resolve();
      },
    };

    await expect(
      processFailuresJob(triageJob(target), deps({ pacing }).deps),
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect(pauses).toEqual([new Date(reset * 1000)]);
    expect((await jobOf(failedRunId)).errorWindow).toBeNull();
  });
});

describe("failureJobs", () => {
  const target = (): FailureTarget => ({
    orgId: randomUUID(),
    failureId: randomUUID(),
    installationId: githubId(),
  });

  it("queues one delayed window close per failure, however often it's asked", async () => {
    const t = target();
    const at = new Date(Date.now() + 5 * 60_000);
    const jobs = failureJobs(queue);

    await jobs.scheduleWindowClose(t, at);
    await jobs.scheduleWindowClose(t, at);

    const job = await queue.getJob(`close-window-${t.failureId}`);
    expect(await job?.getState()).toBe("delayed");
    expect(job?.data).toEqual({ ...t, installationId: String(t.installationId) });
    expect(job?.opts.delay).toBeGreaterThan(4 * 60_000);
    const delayed = await queue.getDelayed();
    expect(delayed.filter((j) => j.data.failureId === t.failureId)).toHaveLength(1);
  });

  it("closes right away when the time is already past", async () => {
    const t = target();

    await failureJobs(queue).scheduleWindowClose(t, new Date(Date.now() - 1000));

    const job = await queue.getJob(`close-window-${t.failureId}`);
    expect(job?.opts.delay).toBe(0);
  });

  it("queues triage once per failure, and once more per late run", async () => {
    const t = target();
    const jobs = failureJobs(queue);

    await jobs.enqueueTriage(t);
    await jobs.enqueueTriage(t);
    await jobs.enqueueTriage(t, "123-1");

    await expect(queue.getJob(`triage-${t.failureId}`)).resolves.toBeDefined();
    await expect(queue.getJob(`triage-${t.failureId}-123-1`)).resolves.toBeDefined();
    const waiting = await queue.getWaiting();
    expect(waiting.filter((j) => j.data.failureId === t.failureId)).toHaveLength(2);
  });
});
