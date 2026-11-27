// Needs Postgres and Redis: `docker compose up -d`. GitHub (and its log storage) is msw, started
// here: integration tests have no shared msw server. Real BullMQ, on a unique key prefix.
import { z } from "zod";
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
import type { TriageModel } from "../triage-model";
import {
  createFailuresQueue,
  failureJobs,
  processFailuresJob,
  type FailureJobs,
  type FailuresDeps,
  type FailuresQueue,
} from "./failures";
import { MAX_MODEL_CALLS_PER_FAILURE, type FailureTarget } from "./triage";

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
  const recentChanges: FailureTarget[] = [];
  const flakyChecks: { target: FailureTarget; key: string | undefined }[] = [];
  const policyFiles: FailureTarget[] = [];
  const jobs: FailureJobs = {
    scheduleWindowClose: () => Promise.resolve(),
    enqueueTriage: (target, key) => {
      triaged.push({ target, key });
      return Promise.resolve();
    },
    enqueueRecentChanges: (target) => {
      recentChanges.push(target);
      return Promise.resolve();
    },
    enqueueFlakyCheck: (target, key) => {
      flakyChecks.push({ target, key });
      return Promise.resolve();
    },
    enqueuePolicyFile: (target) => {
      policyFiles.push(target);
      return Promise.resolve();
    },
  };
  const all: FailuresDeps = {
    db,
    logger,
    githubApp: createGitHubApp({ appId: 1234, privateKey, retries: 0 }),
    pacing: openPacing,
    jobs,
    triageModel: null,
    ...overrides,
  };
  return { deps: all, triaged, recentChanges, flakyChecks, policyFiles };
}

/** An org with a repo and a failure with one failed job; its window still open. */
async function openFailure(options: { headBranch?: string | null } = {}) {
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
    headBranch: options.headBranch === undefined ? "main" : options.headBranch,
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
  return {
    target,
    system,
    repoId: repo.id,
    repoFullName: repo.fullName,
    githubRepoId: repo.githubRepoId,
    githubJobId,
    failedRunId: run.id,
  };
}

/** Answers installation token requests; returns their bodies (what scope each asked for). */
function mockToken(): unknown[] {
  const bodies: unknown[] = [];
  github.use(
    http.post("https://api.github.com/app/installations/:id/access_tokens", async ({ request }) => {
      // An unscoped token request (the flaky check re-runs jobs) has no body.
      const text = await request.text();
      const body: unknown = text === "" ? {} : JSON.parse(text);
      bodies.push(body);
      const scope = z
        .object({
          repository_ids: z.array(z.number()),
          permissions: z.record(z.string(), z.string()),
        })
        .safeParse(body);
      return HttpResponse.json(
        {
          token: "ghs_testInstallationToken00000000000000",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          // GitHub's answer to a scoped request: the scope it granted.
          ...(scope.success
            ? {
                repository_selection: "selected",
                permissions: { ...scope.data.permissions, metadata: "read" },
                repositories: scope.data.repository_ids.map((id) => ({ id })),
              }
            : {}),
        },
        { status: 201 },
      );
    }),
  );
  return bodies;
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
  "2026-09-28T23:22:10.1103456Z shell: /usr/bin/bash -e {0}",
  "2026-09-28T23:22:10.1104567Z ##[endgroup]",
  // The step's own output leaks a token: it must be redacted before it's stored.
  `2026-09-28T23:22:10.1112345Z + export GITHUB_TOKEN=${PLANTED_TOKEN}`,
  "2026-09-28T23:22:12.1101234Z \u001b[96msrc/receipt.ts\u001b[0m:1:25 - error TS2305: Module '\"./cart\"' has no exported member 'lineTotal'.",
  "2026-09-28T23:22:12.1112345Z ##[error]Process completed with exit code 2.",
  // Post-job steps follow the failed step in the job log: not part of the error window.
  "2026-09-28T23:22:12.2201234Z Post job cleanup.",
  "2026-09-28T23:22:12.2212345Z Removing credentials config '/home/runner/work/_temp/git-credentials.config'",
  "2026-09-28T23:22:12.2223456Z Cleaning up orphan processes",
  "",
].join("\n");

// Nothing here the heuristics recognize: TRIAGE_MODEL's job.
const UNCLEAR_LOG = [
  "2026-09-28T23:22:10.1102345Z ##[group]Run make",
  "2026-09-28T23:22:10.1104567Z ##[endgroup]",
  `2026-09-28T23:22:10.1112345Z token=${PLANTED_TOKEN}`,
  "2026-09-28T23:22:12.1101234Z make: *** [all] Error 2",
  "2026-09-28T23:22:12.1112345Z ##[error]Process completed with exit code 2.",
  "",
].join("\n");

const MODEL_CALL = {
  purpose: "triage",
  model: "claude-haiku-4-5-20251001",
  promptVersion: "triage-v1",
  inputTokens: 900,
  outputTokens: 60,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.0012,
};

/** A TriageModel that records one call and answers `answer` (null: no valid answer). */
function fakeModel(answer: Awaited<ReturnType<TriageModel["classify"]>>) {
  const inputs: Parameters<TriageModel["classify"]>[0][] = [];
  const model: TriageModel & { inputs: typeof inputs } = {
    inputs,
    async classify(input, record) {
      inputs.push(input);
      await record({ ...MODEL_CALL, outcome: answer === null ? "invalid" : "valid" });
      return answer;
    },
  };
  return model;
}

describe("close-window job", () => {
  it("closes the collection window, then queues the failure's triage and policy file", async () => {
    const { target } = await openFailure();
    const { deps: d, triaged, policyFiles } = deps();

    await processFailuresJob(
      { name: "close-window", data: { ...target, installationId: String(target.installationId) } },
      d,
    );

    const closed = await db.pipelineFailure.findUniqueOrThrow({ where: { id: target.failureId } });
    expect(closed.windowClosedAt).toBeInstanceOf(Date);
    expect(triaged).toEqual([{ target, key: undefined }]);
    expect(policyFiles).toEqual([target]);
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
    const { target, repoFullName, githubJobId, failedRunId, githubRepoId } = await openFailure();
    const tokenRequests = mockToken();
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
    expect(job.signals).toMatchObject({
      failedStep: "Typecheck",
      exitCode: 2,
      tools: ["tsc"],
      errorCodes: ["TS2305"],
      locations: [{ path: "src/receipt.ts", line: 1, column: 25 }],
    });
    const asText = (value: unknown) =>
      JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? String(v) : v));
    const everything =
      asText(await db.failedJob.findMany({ where: { failedRunId } })) +
      asText(await db.auditLog.findMany({ where: { orgId: target.orgId } }));
    expect(everything).not.toContain(PLANTED_TOKEN);
    // The log feeds a model: it was read with a token for this repository only, read-only.
    expect(tokenRequests).toEqual([
      {
        repository_ids: [Number(githubRepoId)],
        permissions: { contents: "read", actions: "read" },
      },
    ]);
  });

  it("classifies the job with heuristics, then the failure from its jobs (SPEC §6.2 step 6)", async () => {
    const { target, repoFullName, githubJobId, failedRunId } = await openFailure();
    mockToken();
    mockLog(repoFullName, githubJobId, LOG);
    const model = fakeModel(null);

    await processFailuresJob(triageJob(target), deps({ triageModel: model }).deps);

    expect(await jobOf(failedRunId)).toMatchObject({
      category: "TYPECHECK",
      confidence: 0.95,
      summary:
        "tsc TS2305: Module '\"./cart\"' has no exported member 'lineTotal'. (src/receipt.ts:1)",
    });
    expect(model.inputs).toEqual([]);
    const failure = await db.pipelineFailure.findUniqueOrThrow({ where: { id: target.failureId } });
    expect(failure).toMatchObject({ status: "TRIAGED", category: "TYPECHECK", confidence: 0.95 });
    await expect(db.modelCall.count({ where: { failureId: target.failureId } })).resolves.toBe(0);
  });

  it("asks TRIAGE_MODEL when heuristics can't tell, with the redacted window, and records the call", async () => {
    const { target, repoFullName, githubJobId, failedRunId } = await openFailure();
    mockToken();
    mockLog(repoFullName, githubJobId, UNCLEAR_LOG);
    const model = fakeModel({
      category: "build",
      confidence: 0.6,
      summary: "make's default target failed.",
      suspectedFiles: ["Makefile"],
    });

    await processFailuresJob(triageJob(target), deps({ triageModel: model }).deps);

    expect(model.inputs).toHaveLength(1);
    expect(model.inputs[0]).toMatchObject({ workflowName: "CI", jobName: "check" });
    expect(model.inputs[0]?.window).toContain("make: *** [all] Error 2");
    expect(model.inputs[0]?.window).not.toContain(PLANTED_TOKEN);
    expect(await jobOf(failedRunId)).toMatchObject({ category: "BUILD", confidence: 0.6 });
    const failure = await db.pipelineFailure.findUniqueOrThrow({ where: { id: target.failureId } });
    expect(failure).toMatchObject({ status: "TRIAGED", category: "BUILD" });
    const calls = await db.modelCall.findMany({ where: { failureId: target.failureId } });
    expect(calls).toMatchObject([
      {
        orgId: target.orgId,
        purpose: "triage",
        model: MODEL_CALL.model,
        outcome: "valid",
        inputTokens: 900,
      },
    ]);
    expect(calls[0]?.costUsd.toString()).toBe("0.0012");
  });

  it("stops asking the model once the failure has used its model calls (retries included)", async () => {
    const { target, system, repoFullName, githubJobId, failedRunId } = await openFailure();
    for (let i = 0; i < MAX_MODEL_CALLS_PER_FAILURE; i++) {
      await system.failures.recordModelCall(target.failureId, { ...MODEL_CALL, outcome: "valid" });
    }
    mockToken();
    mockLog(repoFullName, githubJobId, UNCLEAR_LOG);
    const model = fakeModel({
      category: "build",
      confidence: 0.6,
      summary: "make's default target failed.",
      suspectedFiles: [],
    });

    await processFailuresJob(triageJob(target), deps({ triageModel: model }).deps);

    expect(model.inputs).toEqual([]);
    expect(await jobOf(failedRunId)).toMatchObject({ category: "UNKNOWN" });
  });

  it("leaves the job unknown when heuristics can't tell and there's no model (or no answer)", async () => {
    for (const triageModel of [null, fakeModel(null)]) {
      const { target, repoFullName, githubJobId, failedRunId } = await openFailure();
      mockToken();
      mockLog(repoFullName, githubJobId, UNCLEAR_LOG);

      await processFailuresJob(triageJob(target), deps({ triageModel }).deps);

      expect(await jobOf(failedRunId)).toMatchObject({ category: "UNKNOWN", confidence: 0 });
      const failure = await db.pipelineFailure.findUniqueOrThrow({
        where: { id: target.failureId },
      });
      expect(failure).toMatchObject({ status: "TRIAGED", category: "UNKNOWN" });
    }
  });

  it("windows a long log to the failure and its end, and doesn't fetch a job it already triaged", async () => {
    const { target, repoFullName, githubJobId, failedRunId } = await openFailure();
    mockToken();
    const lines = Array.from({ length: 1_000 }, (_, i) => `step output ${String(i)}`);
    lines[500] = "Error: the real failure";
    mockLog(repoFullName, githubJobId, lines.join("\n"));
    await processFailuresJob(triageJob(target), deps().deps);

    const window = (await jobOf(failedRunId)).errorWindow ?? "";
    expect(window.split("\n").length).toBeLessThanOrEqual(300);
    expect(window).toContain("Error: the real failure");
    expect(window.endsWith("step output 999")).toBe(true);
    expect(window).toMatch(/lines omitted/);

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

    expect(await jobOf(failedRunId)).toMatchObject({ errorWindow: "", category: "UNKNOWN" });
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

  it("queues the recent changes once per failure", async () => {
    const t = target();
    const jobs = failureJobs(queue);

    await jobs.enqueueRecentChanges(t);
    await jobs.enqueueRecentChanges(t);

    const job = await queue.getJob(`recent-changes-${t.failureId}`);
    expect(job?.name).toBe("recent-changes");
    const waiting = await queue.getWaiting();
    expect(waiting.filter((j) => j.data.failureId === t.failureId)).toHaveLength(1);
  });
});

describe("recent-changes job (SPEC §6.2 step 7)", () => {
  const HEAD = "a".repeat(40);
  const GREEN = "b".repeat(40);
  const LATER = "c".repeat(40);
  const TIP = "d".repeat(40);

  function recentChangesJob(target: FailureTarget) {
    return {
      name: "recent-changes",
      data: { ...target, installationId: String(target.installationId) },
    };
  }

  function greenRun(id: number, headSha: string, branch: string, forkRepoId?: number) {
    return {
      id,
      run_attempt: 1,
      workflow_id: 1,
      name: "CI",
      path: ".github/workflows/ci.yml",
      head_sha: headSha,
      head_branch: branch,
      event: "push",
      status: "completed",
      conclusion: "success",
      html_url: `https://github.com/x/y/actions/runs/${String(id)}`,
      repository: { id: 1, full_name: "x/y" },
      head_repository: { id: forkRepoId ?? 1, full_name: "x/y" },
    };
  }

  function comparison(status: string, files: object[], totalCommits = 1) {
    return {
      status,
      ahead_by: totalCommits,
      behind_by: 0,
      total_commits: totalCommits,
      commits: Array.from({ length: totalCommits }, (_, i) => ({
        sha: String(i + 1)
          .repeat(40)
          .slice(0, 40),
        commit: { message: `fix: change ${String(i + 1)}\n\nbody` },
        author: { login: "dev" },
      })),
      files,
    };
  }

  const RECEIPT_PATCH = [
    "@@ -1,2 +1,2 @@",
    `-import { lineTotal } from "./cart";`,
    `+import { lineTotals } from "./cart";`,
    " const x = 1;",
  ].join("\n");

  /**
   * GitHub for this repo: green runs per workflow and branch, comparisons per base SHA (a number
   * is an error status), the default branch's tip. Records the calls made.
   */
  function mockRepo(
    fullName: string,
    options: {
      greenRuns?: Record<string, ReturnType<typeof greenRun>[]>;
      comparisons?: Record<string, ReturnType<typeof comparison> | number>;
      tip?: string | null;
    },
  ) {
    const calls: string[] = [];
    const api = `https://api.github.com/repos/${fullName}`;
    github.use(
      http.get(`${api}/actions/workflows/:workflowId/runs`, ({ request, params }) => {
        const branch = new URL(request.url).searchParams.get("branch") ?? "";
        calls.push(`runs ${String(params.workflowId)} ${branch}`);
        const runs = options.greenRuns?.[`${String(params.workflowId)} ${branch}`] ?? [];
        return HttpResponse.json({ total_count: runs.length, workflow_runs: runs });
      }),
      http.get(`${api}/compare/:basehead`, ({ params }) => {
        const base = String(params.basehead).split("...")[0] ?? "";
        calls.push(`compare ${base.slice(0, 7)}`);
        const answer = options.comparisons?.[base];
        if (answer === undefined || typeof answer === "number") {
          return HttpResponse.json({ message: "Not Found" }, { status: answer ?? 404 });
        }
        return HttpResponse.json(answer);
      }),
      http.get(`${api}/git/ref/*`, () => {
        calls.push("tip");
        return options.tip === undefined || options.tip === null
          ? HttpResponse.json({ message: "Not Found" }, { status: 404 })
          : HttpResponse.json({ ref: "refs/heads/main", object: { sha: options.tip } });
      }),
    );
    return calls;
  }

  async function storedChanges(failureId: string) {
    const failure = await db.pipelineFailure.findUniqueOrThrow({ where: { id: failureId } });
    return failure.recentChanges;
  }

  it("is queued by triage once the jobs are classified", async () => {
    const { target, repoFullName, githubJobId } = await openFailure();
    mockToken();
    mockLog(repoFullName, githubJobId, LOG);
    const { deps: d, recentChanges } = deps();

    await processFailuresJob({ name: "triage", data: recentChangesJob(target).data }, d);

    expect(recentChanges).toEqual([target]);
  });

  it("compares with the workflow's last green run on the same branch, named files first, redacted", async () => {
    const { target, system, repoFullName, failedRunId } = await openFailure({
      headBranch: "feature/x",
    });
    const job = await jobOf(failedRunId);
    await system.failures.recordJobTriage(job.id, {
      errorWindow: "error TS2305",
      signals: {
        failedStep: "Typecheck",
        exitCode: 2,
        tools: ["tsc"],
        diagnostics: [],
        failingTests: [],
        locations: [{ path: "src/receipt.ts", line: 1 }],
        errorCodes: ["TS2305"],
      },
    });
    mockToken();
    const calls = mockRepo(repoFullName, {
      greenRuns: {
        "1 feature/x": [
          greenRun(30, HEAD, "feature/x"), // the failing commit itself (another event): skipped
          greenRun(29, LATER, "feature/x"), // after the failing commit: skipped
          greenRun(28, "e".repeat(40), "feature/x", 999), // a fork's: never compared
          greenRun(27, GREEN, "feature/x"),
        ],
      },
      comparisons: {
        [LATER]: comparison("behind", []),
        [GREEN]: comparison(
          "ahead",
          [
            {
              filename: "README.md",
              status: "modified",
              additions: 1,
              deletions: 0,
              patch: `@@ -1 +1 @@\n+export TOKEN=${PLANTED_TOKEN}`,
            },
            {
              filename: "src/receipt.ts",
              status: "modified",
              additions: 1,
              deletions: 1,
              patch: RECEIPT_PATCH,
            },
          ],
          2,
        ),
      },
    });

    await processFailuresJob(recentChangesJob(target), deps().deps);

    expect(calls).toEqual([
      "runs 1 feature/x",
      `compare ${LATER.slice(0, 7)}`,
      `compare ${GREEN.slice(0, 7)}`,
    ]);
    const stored = await storedChanges(target.failureId);
    expect(stored).toMatchObject({
      base: { sha: GREEN, source: "same-branch", branch: "feature/x", runId: "27" },
      changes: {
        totalCommits: 2,
        commits: [
          { subject: "fix: change 1", authorLogin: "dev" },
          { subject: "fix: change 2", authorLogin: "dev" },
        ],
        files: [
          { path: "src/receipt.ts", priority: true, patchState: "full", patch: RECEIPT_PATCH },
          { path: "README.md", priority: false, patchState: "full" },
        ],
      },
    });
    const audit = await db.auditLog.findFirstOrThrow({
      where: { orgId: target.orgId, action: "failure.recent_changes" },
    });
    expect(audit.metadata).toMatchObject({ baseSha: GREEN, source: "same-branch", files: 2 });
    const everything = JSON.stringify(stored) + JSON.stringify(audit);
    expect(everything).not.toContain(PLANTED_TOKEN);
    expect(JSON.stringify(stored)).toContain("[redacted:");
  });

  it("falls back to the default branch's last green run, even when the branch diverged from it", async () => {
    const { target, repoFullName } = await openFailure({ headBranch: "feature/x" });
    mockToken();
    mockRepo(repoFullName, {
      greenRuns: { "1 main": [greenRun(40, GREEN, "main")] },
      comparisons: { [GREEN]: comparison("diverged", []) },
    });

    await processFailuresJob(recentChangesJob(target), deps().deps);

    expect(await storedChanges(target.failureId)).toMatchObject({
      base: { sha: GREEN, source: "default-branch", branch: "main", runId: "40" },
    });
  });

  it("uses the merge base with the default branch when no green run exists", async () => {
    const { target, repoFullName } = await openFailure({ headBranch: "feature/x" });
    mockToken();
    const calls = mockRepo(repoFullName, {
      tip: TIP,
      comparisons: { [TIP]: comparison("diverged", [], 3) },
    });

    await processFailuresJob(recentChangesJob(target), deps().deps);

    expect(calls).toEqual(["runs 1 feature/x", "runs 1 main", "tip", `compare ${TIP.slice(0, 7)}`]);
    expect(await storedChanges(target.failureId)).toMatchObject({
      base: { sha: TIP, source: "merge-base", branch: "main", runId: null },
      changes: { totalCommits: 3 },
    });
  });

  it("records that there's no base when nothing comes before the failing commit", async () => {
    const { target, repoFullName } = await openFailure({ headBranch: "main" });
    mockToken();
    // On the default branch, its tip is the failing commit itself: nothing to compare.
    const calls = mockRepo(repoFullName, { tip: HEAD });

    await processFailuresJob(recentChangesJob(target), deps().deps);

    expect(calls).toEqual(["runs 1 main", "tip"]);
    expect(await storedChanges(target.failureId)).toMatchObject({ base: null });
    const audit = await db.auditLog.findFirstOrThrow({
      where: { orgId: target.orgId, action: "failure.recent_changes" },
    });
    expect(audit.metadata).toMatchObject({ base: null });
  });

  it("skips green commits it can't use, and stops after three comparisons per branch", async () => {
    const { target, repoFullName } = await openFailure({ headBranch: "feature/x" });
    mockToken();
    const [gone, behind, same, fourth] = ["1", "2", "3", "4"].map((c) => c.repeat(40));
    const calls = mockRepo(repoFullName, {
      greenRuns: {
        "1 feature/x": [gone, behind, same, fourth].map((sha, i) =>
          greenRun(50 + i, sha ?? "", "feature/x"),
        ),
        "1 main": [greenRun(60, GREEN, "main")],
      },
      comparisons: {
        [gone ?? ""]: 404,
        [behind ?? ""]: comparison("behind", []),
        [same ?? ""]: comparison("identical", []),
        [fourth ?? ""]: comparison("ahead", []),
        [GREEN]: comparison("ahead", []),
      },
    });

    await processFailuresJob(recentChangesJob(target), deps().deps);

    expect(calls.filter((call) => call.startsWith("compare"))).toHaveLength(4);
    expect(await storedChanges(target.failureId)).toMatchObject({
      base: { sha: GREEN, source: "default-branch" },
    });
  });

  it("takes the widest comparison when several workflows failed", async () => {
    const { target, system, repoId, repoFullName } = await openFailure({
      headBranch: "feature/x",
    });
    await system.failures.recordFailedRun(repoId, {
      headSha: HEAD,
      headBranch: "feature/x",
      runId: githubId(),
      runAttempt: 1,
      workflowId: 2n,
      workflowName: "Lint",
      workflowPath: ".github/workflows/lint.yml",
      conclusion: "failure",
      htmlUrl: null,
      jobs: [{ githubJobId: githubId(), name: "lint", failedStep: "Lint", htmlUrl: null }],
    });
    mockToken();
    mockRepo(repoFullName, {
      greenRuns: {
        "1 feature/x": [greenRun(70, GREEN, "feature/x")],
        "2 feature/x": [greenRun(71, LATER, "feature/x")],
      },
      comparisons: {
        [GREEN]: comparison("ahead", [], 1),
        [LATER]: comparison("ahead", [], 4),
      },
    });

    await processFailuresJob(recentChangesJob(target), deps().deps);

    expect(await storedChanges(target.failureId)).toMatchObject({
      base: { sha: LATER, runId: "71" },
      changes: { totalCommits: 4 },
    });
  });

  it("resolves once: a repeated job calls GitHub no more", async () => {
    const { target, repoFullName } = await openFailure({ headBranch: "main" });
    mockToken();
    const calls = mockRepo(repoFullName, { tip: HEAD });

    await processFailuresJob(recentChangesJob(target), deps().deps);
    await processFailuresJob(recentChangesJob(target), deps().deps);

    expect(calls).toEqual(["runs 1 main", "tip"]);
  });

  it("waits, without calling GitHub, while the installation is paused", async () => {
    const { target } = await openFailure();
    const pacing: InstallationPacing = {
      ...openPacing,
      pausedUntil: () => Promise.resolve(new Date(Date.now() + 60_000)),
    };

    await expect(
      processFailuresJob(recentChangesJob(target), deps({ pacing }).deps),
    ).rejects.toThrow(RateLimitedError);
    expect(await storedChanges(target.failureId)).toBeNull();
  });
});

describe("flaky-check job (SPEC §6.2 step 8)", () => {
  const CI_YAML = "on: [push]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps: []\n";
  const DEPLOY_YAML =
    "on: [push]\njobs:\n  ship:\n    runs-on: ubuntu-latest\n    environment: production\n    steps: []\n";

  function flakyCheckJob(target: FailureTarget) {
    return {
      name: "flaky-check",
      data: { ...target, installationId: String(target.installationId) },
    };
  }

  /** A triaged failure on a watched workflow (CI, GitHub workflow ID 1). */
  async function triagedFailure(options: { selected?: boolean; usesEnvironment?: boolean } = {}) {
    const opened = await openFailure();
    // A failure only exists for an enabled repository (the workflow_run processor's filter).
    await db.repository.update({ where: { id: opened.repoId }, data: { enabled: true } });
    await opened.system.workflows.syncInstalled(opened.repoId, [
      {
        githubWorkflowId: 1n,
        path: ".github/workflows/ci.yml",
        name: "CI",
        selected: options.selected ?? true,
        usesEnvironment: options.usesEnvironment ?? false,
      },
    ]);
    await opened.system.failures.recordTriage(opened.target.failureId, {
      category: "test",
      confidence: 0.9,
      summary: "1 failing test",
    });
    const run = await db.failedRun.findUniqueOrThrow({ where: { id: opened.failedRunId } });
    return { ...opened, runId: run.runId };
  }

  /** GitHub for this repo: the workflow file at the failing commit, the run, and re-runs. */
  const DEFAULT_TIP = "d".repeat(40);

  /**
   * GitHub for this repo: the workflow file at the failing commit (and, when `defaultYaml` is
   * given, a default branch that moved on, with its own copy), the run, and re-runs.
   */
  function mockRerun(
    fullName: string,
    runId: bigint,
    workflowYaml: string | null,
    status = 201,
    defaultYaml?: string,
  ) {
    const calls: string[] = [];
    const api = `https://api.github.com/repos/${fullName}`;
    github.use(
      http.get(`${api}/git/ref/*`, () =>
        HttpResponse.json({
          ref: "refs/heads/main",
          object: { sha: defaultYaml === undefined ? "a".repeat(40) : DEFAULT_TIP },
        }),
      ),
      http.get(`${api}/contents/*`, ({ request }) => {
        const ref = new URL(request.url).searchParams.get("ref") ?? "";
        calls.push(`file ${ref}`);
        const yaml = ref === DEFAULT_TIP ? (defaultYaml ?? null) : workflowYaml;
        if (yaml === null) return HttpResponse.json({ message: "Not Found" }, { status: 404 });
        const content = Buffer.from(yaml).toString("base64");
        return HttpResponse.json({
          type: "file",
          path: ".github/workflows/ci.yml",
          size: yaml.length,
          encoding: "base64",
          content,
        });
      }),
      http.get(`${api}/actions/runs/${String(runId)}`, () =>
        HttpResponse.json({
          id: Number(runId),
          run_attempt: 1,
          workflow_id: 1,
          name: "CI",
          path: ".github/workflows/ci.yml",
          head_sha: "a".repeat(40),
          head_branch: "main",
          event: "push",
          status: "completed",
          conclusion: "failure",
          html_url: "https://github.com/x/y/actions/runs/1",
          repository: { id: 1, full_name: fullName },
          head_repository: { id: 1, full_name: fullName },
        }),
      ),
      http.post(`${api}/actions/runs/${String(runId)}/rerun-failed-jobs`, () => {
        calls.push("rerun");
        return status === 201
          ? new HttpResponse(null, { status: 201 })
          : HttpResponse.json({ message: "Refused" }, { status });
      }),
    );
    return calls;
  }

  it("is queued by triage, under the triage job's key", async () => {
    const { target, repoFullName, githubJobId } = await openFailure();
    mockToken();
    mockLog(repoFullName, githubJobId, LOG);
    const { deps: d, flakyChecks } = deps();
    const data = { ...target, installationId: String(target.installationId) };

    await processFailuresJob({ id: `triage-${target.failureId}`, name: "triage", data }, d);
    await processFailuresJob({ id: `triage-${target.failureId}-77-2`, name: "triage", data }, d);

    expect(flakyChecks).toEqual([
      { target, key: undefined },
      { target, key: "77-2" },
    ]);
  });

  it("re-runs the failed jobs once, reading the workflow at the failing commit", async () => {
    const { target, repoFullName, failedRunId, runId } = await triagedFailure();
    mockToken();
    const calls = mockRerun(repoFullName, runId, CI_YAML);

    await processFailuresJob(flakyCheckJob(target), deps().deps);
    await processFailuresJob(flakyCheckJob(target), deps().deps);

    expect(calls).toEqual([`file ${"a".repeat(40)}`, "rerun"]);
    expect(await db.failedRun.findUniqueOrThrow({ where: { id: failedRunId } })).toMatchObject({
      rerunByUs: true,
      rerunFromAttempt: 1,
    });
    const audit = await db.auditLog.findFirstOrThrow({
      where: { orgId: target.orgId, action: "failure.rerun_requested" },
    });
    expect(audit.metadata).toMatchObject({ runId: String(runId), runAttempt: 1 });
  });

  it("never re-runs a workflow that declares an environment at the failing commit, and remembers it", async () => {
    const { target, repoId, repoFullName, failedRunId, runId } = await triagedFailure();
    mockToken();
    const calls = mockRerun(repoFullName, runId, DEPLOY_YAML);

    await processFailuresJob(flakyCheckJob(target), deps().deps);

    expect(calls).toEqual([`file ${"a".repeat(40)}`]);
    const workflow = await db.repoWorkflow.findFirstOrThrow({ where: { repoId } });
    expect(workflow.usesEnvironment).toBe(true);
    expect(await db.failedRun.findUniqueOrThrow({ where: { id: failedRunId } })).toMatchObject({
      rerunByUs: false,
    });
  });

  it.each([
    ["an environment is already known", { usesEnvironment: true }, CI_YAML],
    ["the workflow is no longer watched", { selected: false }, CI_YAML],
    ["the workflow file can't be read", {}, null],
    ["the workflow file isn't a workflow", {}, "- just\n- a list\n"],
  ])("doesn't re-run when %s", async (_label, options, yaml) => {
    const { target, repoFullName, failedRunId, runId } = await triagedFailure(options);
    mockToken();
    const calls = mockRerun(repoFullName, runId, yaml);

    await processFailuresJob(flakyCheckJob(target), deps().deps);

    expect(calls).not.toContain("rerun");
    expect(await db.failedRun.findUniqueOrThrow({ where: { id: failedRunId } })).toMatchObject({
      rerunByUs: false,
    });
  });

  it("does nothing when the repository's policy turns retryBeforeHeal off", async () => {
    const { target, repoFullName, runId, repoId, system } = await triagedFailure();
    await system.policies.save("REPO", repoId, { scope: { retryBeforeHeal: false } });
    mockToken();
    const calls = mockRerun(repoFullName, runId, CI_YAML);

    await processFailuresJob(flakyCheckJob(target), deps().deps);

    expect(calls).toEqual([]);
  });

  it("follows .pipeheal.yml turning retryBeforeHeal off, whatever the dashboard says", async () => {
    const { target, repoFullName, runId, repoId, system } = await triagedFailure();
    await system.policies.save("REPO", repoId, { scope: { retryBeforeHeal: true } });
    await system.repositories.recordPolicyFile(repoId, {
      commitSha: "d".repeat(40),
      layer: { scope: { retryBeforeHeal: false } },
      errors: null,
    });
    mockToken();
    const calls = mockRerun(repoFullName, runId, CI_YAML);

    await processFailuresJob(flakyCheckJob(target), deps().deps);

    expect(calls).toEqual([]);
  });

  it("never re-runs a workflow that could deploy through a dependent job", async () => {
    const reusable = [
      "on: [push]",
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    steps: []",
      "  ship:",
      "    needs: test",
      "    uses: ./.github/workflows/deploy.yml",
      "",
    ].join("\n");
    const { target, repoFullName, runId } = await triagedFailure();
    mockToken();
    const calls = mockRerun(repoFullName, runId, reusable);

    await processFailuresJob(flakyCheckJob(target), deps().deps);

    expect(calls).not.toContain("rerun");
  });

  it("checks the default branch's copy too (a pull_request run executes the merge)", async () => {
    const withDeploy = [
      "on: [push]",
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    steps: []",
      "  deploy:",
      "    needs: test",
      "    runs-on: ubuntu-latest",
      "    steps: []",
      "",
    ].join("\n");
    const { target, repoFullName, runId } = await triagedFailure();
    mockToken();
    const calls = mockRerun(repoFullName, runId, CI_YAML, 201, withDeploy);

    await processFailuresJob(flakyCheckJob(target), deps().deps);

    expect(calls).toEqual([`file ${"a".repeat(40)}`, `file ${DEFAULT_TIP}`]);
  });

  it("re-runs when both copies are plain CI", async () => {
    const { target, repoFullName, runId } = await triagedFailure();
    mockToken();
    const calls = mockRerun(repoFullName, runId, CI_YAML, 201, CI_YAML);

    await processFailuresJob(flakyCheckJob(target), deps().deps);

    expect(calls).toEqual([`file ${"a".repeat(40)}`, `file ${DEFAULT_TIP}`, "rerun"]);
  });

  it.each([
    ["the repository is disabled", { enabled: false }],
    ["the organization is suspended", { suspended: true }],
  ])("doesn't re-run when %s", async (_label, state) => {
    const { target, system, repoId, repoFullName, runId } = await triagedFailure();
    if ("enabled" in state) {
      await db.repository.update({ where: { id: repoId }, data: { enabled: false } });
    } else {
      await db.organization.update({ where: { id: target.orgId }, data: { status: "SUSPENDED" } });
    }
    mockToken();
    const calls = mockRerun(repoFullName, runId, CI_YAML);

    await processFailuresJob(flakyCheckJob(target), deps().deps);

    expect(calls).toEqual([]);
    expect(system.org.id).toBe(target.orgId);
  });

  it("only checks a triaged failure", async () => {
    const { target, repoFullName, runId } = await triagedFailure();
    await db.pipelineFailure.update({ where: { id: target.failureId }, data: { status: "FLAKY" } });
    mockToken();
    const calls = mockRerun(repoFullName, runId, CI_YAML);

    await processFailuresJob(flakyCheckJob(target), deps().deps);

    expect(calls).toEqual([]);
  });

  it("keeps the claim when GitHub refuses the re-run, and never asks again", async () => {
    const { target, repoFullName, failedRunId, runId } = await triagedFailure();
    mockToken();
    const calls = mockRerun(repoFullName, runId, CI_YAML, 403);

    await processFailuresJob(flakyCheckJob(target), deps().deps);
    await processFailuresJob(flakyCheckJob(target), deps().deps);

    expect(calls.filter((call) => call === "rerun")).toHaveLength(1);
    expect(await db.failedRun.findUniqueOrThrow({ where: { id: failedRunId } })).toMatchObject({
      rerunByUs: true,
    });
  });

  it("marks the failure FLAKY when the re-run passes", async () => {
    const { target, system, repoId, repoFullName, runId } = await triagedFailure();
    mockToken();
    mockRerun(repoFullName, runId, CI_YAML);
    await processFailuresJob(flakyCheckJob(target), deps().deps);

    // The re-run's result, as the workflow_run processor records it.
    await system.failures.recordPassedRun(repoId, { runId, runAttempt: 2 });

    expect(
      await db.pipelineFailure.findUniqueOrThrow({ where: { id: target.failureId } }),
    ).toMatchObject({ status: "FLAKY" });
  });

  it("waits, without calling GitHub, while the installation is paused", async () => {
    const { target } = await triagedFailure();
    const pacing: InstallationPacing = {
      ...openPacing,
      pausedUntil: () => Promise.resolve(new Date(Date.now() + 60_000)),
    };

    await expect(processFailuresJob(flakyCheckJob(target), deps({ pacing }).deps)).rejects.toThrow(
      RateLimitedError,
    );
  });
});

describe("policy-file job (P3.7)", () => {
  const TIP = "c".repeat(40);

  /** GitHub for this repo: the default branch at TIP, and `.pipeheal.yml` there (null: none). */
  function mockPolicyFile(fullName: string, yaml: string | null) {
    const calls: string[] = [];
    const api = `https://api.github.com/repos/${fullName}`;
    github.use(
      http.get(`${api}/git/ref/*`, () =>
        HttpResponse.json({ ref: "refs/heads/main", object: { sha: TIP } }),
      ),
      http.get(`${api}/contents/*`, ({ request }) => {
        calls.push(new URL(request.url).pathname.split("/contents/")[1] ?? "");
        if (yaml === null) return HttpResponse.json({ message: "Not Found" }, { status: 404 });
        return HttpResponse.json({
          type: "file",
          path: ".pipeheal.yml",
          size: yaml.length,
          encoding: "base64",
          content: Buffer.from(yaml).toString("base64"),
        });
      }),
    );
    return calls;
  }

  const policyFileJob = (target: FailureTarget) => ({
    name: "policy-file",
    data: { ...target, installationId: String(target.installationId) },
  });

  it("stores a valid file's layer, and reads it again only when the branch moves", async () => {
    const { target, system, repoId, repoFullName } = await openFailure();
    mockToken();
    const calls = mockPolicyFile(repoFullName, "limits:\n  maxFilesChanged: 2\n");

    await processFailuresJob(policyFileJob(target), deps().deps);
    await processFailuresJob(policyFileJob(target), deps().deps);

    const repo = await system.repositories.get(repoId);
    expect(repo).toMatchObject({
      policyFile: { limits: { maxFilesChanged: 2 } },
      policyFileErrors: null,
      policyFileCommitSha: TIP,
    });
    expect(calls).toEqual([".pipeheal.yml"]);
  });

  it("stores the errors of an invalid file, and nothing for a missing one", async () => {
    const invalid = await openFailure();
    mockToken();
    mockPolicyFile(invalid.repoFullName, "limits:\n  maxFilesChanged: 999\n");
    await processFailuresJob(policyFileJob(invalid.target), deps().deps);
    const missing = await openFailure();
    mockPolicyFile(missing.repoFullName, null);
    await processFailuresJob(policyFileJob(missing.target), deps().deps);

    const bad = await invalid.system.repositories.get(invalid.repoId);
    expect(bad?.policyFile).toBeNull();
    expect(bad?.policyFileErrors).toEqual([expect.stringMatching(/^limits\.maxFilesChanged: /)]);
    const none = await missing.system.repositories.get(missing.repoId);
    expect(none).toMatchObject({
      policyFile: null,
      policyFileErrors: null,
      policyFileCommitSha: TIP,
    });
  });
});
