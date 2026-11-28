// Needs Postgres: `docker compose up -d`. The step loop end to end (SPEC §7.3, D15): a runner's
// session drives POST /v1/step and GET /v1/step/:seq against the real database, with the turns
// processor run by a scripted model in place of the queue.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { connect } from "node:net";
import { forSystem, installations, runnerSessions } from "@pipeheal/db";
import { createTestDb } from "@pipeheal/db/testing";
import { createLogger } from "@pipeheal/shared/logger";
import { describe, expect, it } from "vitest";
import { processTurnJob, type TurnJob, type TurnResult } from "../queues/turns";
import { buildGateway } from "./server";
import { hashSessionToken } from "./session";
import { MAX_STEP_BODIES_IN_FLIGHT, SESSION_STEP_RATE_LIMIT, registerStepRoutes } from "./steps";

const db = createTestDb();
const logger = createLogger({ level: "silent", service: "test" });
const sessions = runnerSessions(db, "test");
const githubId = () => BigInt(randomInt(1, 2 ** 47));
const MODEL = {
  model: "qwen3:14b",
  promptVersion: "heal-v1",
  inputTokens: 10,
  outputTokens: 5,
  durationMs: 3,
};
const SECRET = `ghp_${"A1b2C3d4E5".repeat(4)}`;

const START = {
  stepSeq: 1,
  start: {
    reproduced: true,
    check: { name: "test", exitCode: 1, output: `1 failed; token ${SECRET}` },
    fileTree: ["src/cart.ts", "src/cart.test.ts"],
    reports: [],
  },
};

/** A RUNNING attempt with an open session, and the token its runner holds. */
async function session() {
  const login = `T${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const org = await installations(db, "test").upsert({
    githubAccountId: githubId(),
    login,
    accountType: "ORG",
    installationId: githubId(),
  });
  const system = await forSystem(db, org.id, "test");
  const [repo] = await system.repositories.syncInstalled([
    { githubRepoId: githubId(), fullName: `${login}/app`, defaultBranch: "main" },
  ]);
  if (repo === undefined) throw new Error("test setup: no repository");
  await system.repositories.setEnabled(repo.id, true);
  const runId = githubId();
  const { failure } = await system.failures.recordFailedRun(repo.id, {
    headSha: randomUUID().replaceAll("-", "").padEnd(40, "0"),
    headBranch: "main",
    runId,
    runAttempt: 1,
    workflowId: 11n,
    workflowName: "CI",
    workflowPath: ".github/workflows/ci.yml",
    conclusion: "failure",
    htmlUrl: `https://github.com/acme/app/actions/runs/${String(runId)}`,
    jobs: [{ githubJobId: githubId(), name: "check", failedStep: "Test", htmlUrl: null }],
  });
  const attempt = await system.attempts.create({
    failureId: failure.id,
    targetSha: failure.headSha,
    failingCheck: "test",
    dispatchRunId: githubId(),
  });
  const token = randomBytes(32).toString("base64url");
  await sessions.open(
    { attemptId: attempt.id, githubRepoId: repo.githubRepoId, githubOwnerId: org.githubAccountId },
    { tokenHash: hashSessionToken(token), now: new Date() },
  );
  return { token, attemptId: attempt.id };
}

interface Options {
  answers?: TurnResult[];
  /** Delays the step POST's policy lookup, to hold a request in flight. */
  hold?: Promise<void>;
  /** Delays every session lookup by this many milliseconds. */
  slowAuth?: number;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

async function gateway({ answers = [], hold, slowAuth }: Options = {}) {
  const queued: TurnJob[] = [];
  const app = await buildGateway({ logger });
  const state = registerStepRoutes(app, {
    sessions:
      slowAuth === undefined
        ? sessions
        : {
            authenticate: async (hash, now) => {
              await sleep(slowAuth);
              return sessions.authenticate(hash, now);
            },
          },
    attempts: async (orgId) => (await forSystem(db, orgId, "test")).attempts,
    maxIterations: async () => {
      await hold;
      return 10;
    },
    enqueueTurn: (job) => {
      queued.push(job);
      return Promise.resolve();
    },
    longPollMs: 300,
    pollIntervalMs: 20,
  });
  /** Runs the next queued turn with the next scripted answer. */
  async function turn() {
    const job = queued.shift();
    const answer = answers.shift();
    if (job === undefined || answer === undefined) throw new Error("test setup: nothing queued");
    await processTurnJob(
      { name: "turn", data: job },
      {
        attempts: async (orgId) => (await forSystem(db, orgId, "test")).attempts,
        runner: { next: () => Promise.resolve(answer) },
        logger,
      },
    );
  }
  const as = (token: string | null) => ({
    post: (body: unknown) =>
      app.inject({
        method: "POST",
        url: "/v1/step",
        payload: body as object,
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
      }),
    poll: (stepSeq: number | string) =>
      app.inject({
        method: "GET",
        url: `/v1/step/${String(stepSeq)}`,
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
      }),
  });
  return { app, queued, turn, as, state };
}

describe("the step loop over HTTP", () => {
  it("runs start, tool calls, results and a submit, storing tool output redacted", async () => {
    const { token, attemptId } = await session();
    const { app, queued, turn, as } = await gateway({
      answers: [
        { toolCalls: [{ tool: "read_file", path: "src/cart.ts" }], model: MODEL },
        { done: "submit", reason: "fixed the total", model: MODEL },
      ],
    });
    const runner = as(token);

    expect((await runner.post(START)).statusCode).toBe(202);
    expect(queued).toHaveLength(1);
    expect((await runner.poll(1)).json()).toMatchObject({ status: "pending", stepSeq: 1 });
    await turn();
    const ready = (await runner.poll(1)).json<{ toolCalls: { callId: string }[] }>();
    expect(ready).toMatchObject({
      status: "ready",
      stepSeq: 1,
      toolCalls: [{ tool: "read_file", path: "src/cart.ts" }],
    });
    expect(ready.toolCalls[0]?.callId).toMatch(/^s1c1-[0-9a-f]{8}$/);
    const results = {
      stepSeq: 2,
      toolResults: [
        { callId: ready.toolCalls[0]?.callId, ok: true, output: `const key = "${SECRET}";` },
      ],
    };
    expect((await runner.post(results)).statusCode).toBe(202);
    await turn();
    expect((await runner.poll(2)).json()).toEqual({
      status: "done",
      stepSeq: 2,
      outcome: "submit",
      reason: "fixed the total",
    });
    await app.close();

    const events = await db.agentEvent.findMany({ where: { attemptId }, orderBy: { seq: "asc" } });
    expect(JSON.stringify(events.map((event) => event.payload))).not.toContain(SECRET);
    await expect(
      db.healAttempt.findUniqueOrThrow({ where: { id: attemptId } }),
    ).resolves.toMatchObject({ status: "AWAITING_SUBMISSION", iterations: 2 });
  });

  it("answers a long-poll as soon as the turn finishes", async () => {
    const { token } = await session();
    const { app, turn, as } = await gateway({
      answers: [{ done: "gave_up", reason: "needs a secret", model: MODEL }],
    });
    await as(token).post(START);

    const [answer] = await Promise.all([
      as(token).poll(1),
      new Promise((resolve) => setTimeout(resolve, 60)).then(turn),
    ]);
    await app.close();

    expect(answer.json()).toMatchObject({ status: "done", outcome: "gave_up" });
  });

  it("treats a retried POST as the same step and refuses a different one", async () => {
    const { token } = await session();
    const { app, queued, as } = await gateway();

    const first = await as(token).post(START);
    const retry = await as(token).post(START);
    const other = await as(token).post({
      ...START,
      start: { ...START.start, fileTree: ["other.ts"] },
    });
    await app.close();

    expect([first.statusCode, retry.statusCode, other.statusCode]).toEqual([202, 202, 409]);
    // The retry re-queues the still-pending turn (the job ID makes that a no-op in BullMQ).
    expect(queued).toHaveLength(2);
    expect(other.json()).toEqual({ error: "this step was already sent with other content" });
  });

  it("refuses results that don't answer the model's calls, and skipped steps", async () => {
    const { token } = await session();
    const { app, turn, as } = await gateway({
      answers: [{ toolCalls: [{ tool: "list_files", path: "." }], model: MODEL }],
    });
    await as(token).post(START);
    await turn();

    const wrong = await as(token).post({
      stepSeq: 2,
      toolResults: [{ callId: "s9c9", ok: true, output: "" }],
    });
    const skipped = await as(token).post({
      stepSeq: 3,
      toolResults: [{ callId: "s9c9", ok: true, output: "" }],
    });
    await app.close();

    expect(wrong.statusCode).toBe(409);
    expect(skipped.json()).toEqual({ error: "expected step 2" });
  });

  it("ends at once, without a model turn, when the failure doesn't reproduce", async () => {
    const { token } = await session();
    const { app, queued, as } = await gateway();

    await as(token).post({ ...START, start: { ...START.start, reproduced: false } });
    const poll = await as(token).poll(1);
    await app.close();

    expect(queued).toEqual([]);
    expect(poll.json()).toMatchObject({ status: "done", outcome: "not_reproducible" });
  });

  it("keeps the baseline tests it parses from step 1's reports, never the XML", async () => {
    const withReport = await session();
    const without = await session();
    const { app, as } = await gateway();
    const xml =
      '<testsuites><testsuite name="cart"><testcase classname="cart" name="totals">' +
      `<failure message="${SECRET}"/></testcase><testcase classname="cart" name="empty"/>` +
      "</testsuite></testsuites>";

    await as(withReport.token).post({
      ...START,
      start: { ...START.start, reports: [{ path: "reports/junit.xml", xml }] },
    });
    await as(without.token).post(START);
    await app.close();

    const stored = await db.healAttempt.findUniqueOrThrow({ where: { id: withReport.attemptId } });
    expect(stored.baselineTests).toEqual({
      available: true,
      tests: [
        ["cart::totals", ["failed"]],
        ["cart::empty", ["passed"]],
      ],
    });
    const events = await db.agentEvent.findMany({ where: { attemptId: withReport.attemptId } });
    expect(JSON.stringify(events.map((event) => event.payload))).not.toContain(SECRET);
    await expect(
      db.healAttempt.findUniqueOrThrow({ where: { id: without.attemptId } }),
    ).resolves.toMatchObject({
      baselineTests: { available: false, reason: "no JUnit report was found" },
    });
  });

  it("authenticates before reading the body", async () => {
    const { app, as } = await gateway();
    const big = { padding: "x".repeat(100_000) };

    for (const token of [null, "short", randomBytes(32).toString("base64url")]) {
      expect((await as(token).post(big)).statusCode).toBe(401);
      expect((await as(token).poll(1)).statusCode).toBe(401);
    }
    await app.close();
  });

  it("answers 400 to malformed steps and step numbers, 404 to unknown steps", async () => {
    const { token } = await session();
    const { app, as } = await gateway();

    const statuses = [
      (await as(token).post({ stepSeq: 1 })).statusCode,
      (await as(token).poll("zero")).statusCode,
      (await as(token).poll(7)).statusCode,
    ];
    await app.close();

    expect(statuses).toEqual([400, 400, 404]);
  });

  it("lets a session have one POST in flight", async () => {
    const { token } = await session();
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { app, as } = await gateway({ hold });

    const first = as(token).post(START);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await as(token).post(START);
    release();
    const done = await first;
    await app.close();

    expect(second.statusCode).toBe(409);
    expect(done.statusCode).toBe(202);
    expect(MAX_STEP_BODIES_IN_FLIGHT).toBeGreaterThan(1);
  });

  it("gives back every lock and slot, whatever the outcome", async () => {
    const { token } = await session();
    const { app, state, as } = await gateway();
    const runner = as(token);

    await as(null).post(START);
    await runner.post({ stepSeq: 1 });
    await runner.post(START);
    await runner.post({ ...START, start: { ...START.start, fileTree: ["x.ts"] } });
    await runner.poll(9);
    await runner.poll(1);
    await sleep(20);

    expect(state.holding()).toEqual({ locks: 0, bodies: 0, orgs: 0 });
    await app.close();
  });

  it("keeps nothing for a client that leaves while its session is looked up", async () => {
    const { token } = await session();
    const { app, state, as } = await gateway({ slowAuth: 150 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("test setup: no port");

    const socket = connect(address.port, "127.0.0.1");
    const lines = [
      "POST /v1/step HTTP/1.1",
      "Host: gateway",
      `Authorization: Bearer ${token}`,
      "Content-Type: application/json",
      "Content-Length: 1000",
      "",
      "{",
    ];
    socket.write(lines.join("\r\n"));
    await sleep(40);
    socket.destroy();
    await sleep(400);

    expect(state.holding()).toEqual({ locks: 0, bodies: 0, orgs: 0 });
    // The session isn't locked out by the request that went away.
    expect((await as(token).post(START)).statusCode).toBe(202);
    await app.close();
  });

  it("limits requests per session", async () => {
    const { token } = await session();
    const { app, as } = await gateway();
    const statuses: number[] = [];

    for (let i = 0; i <= SESSION_STEP_RATE_LIMIT.max; i += 1) {
      statuses.push((await as(token).poll(5)).statusCode);
    }
    await app.close();

    expect(statuses.slice(0, -1).every((status) => status === 404)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("stores output that redaction made longer cut back to the limit, not refused", async () => {
    const { token, attemptId } = await session();
    const { app, turn, as } = await gateway({
      answers: [{ toolCalls: [{ tool: "run_check", name: "test" }], model: MODEL }],
    });
    await as(token).post(START);
    await turn();
    const ready = (await as(token).poll(1)).json<{ toolCalls: { callId: string }[] }>();
    const output = `password=${"h".repeat(11)}\n`.repeat(3_000);

    const posted = await as(token).post({
      stepSeq: 2,
      toolResults: [{ callId: ready.toolCalls[0]?.callId, ok: false, output }],
    });
    await app.close();

    expect(output.length).toBeLessThanOrEqual(64_000);
    expect(posted.statusCode).toBe(202);
    const result = await db.agentEvent.findFirstOrThrow({
      where: { attemptId, type: "TOOL_RESULT" },
    });
    const payload = result.payload as { output: string; truncated: boolean };
    expect(payload.output.length).toBeLessThanOrEqual(64_000);
    expect(payload.output).not.toContain("h".repeat(11));
  });
});
