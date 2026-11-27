// Needs Postgres: `docker compose up -d`. The step loop's rules (SPEC §7.3, D15) as stored: order,
// idempotency, answers matching calls, the loop's endings and the attempt's status after them.
import { randomInt, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { installations } from "./installations";
import { runnerSessions } from "./runner-sessions";
import { forSystem } from "./scope";
import { createTestDb } from "./testing";

const db = createTestDb();
const sessions = runnerSessions(db, "test");
const githubId = () => BigInt(randomInt(1, 2 ** 47));
const hex = () => randomUUID().replaceAll("-", "").repeat(2);

const MODEL = {
  model: "qwen3:14b",
  promptVersion: "heal-v1",
  inputTokens: 900,
  outputTokens: 40,
  durationMs: 1500,
};

function start(reproduced = true) {
  return {
    stepSeq: 1,
    start: {
      reproduced,
      check: { name: "test" as const, exitCode: reproduced ? 1 : 0, output: "out" },
      fileTree: ["src/a.ts", "src/a.test.ts"],
      reports: [{ path: "reports/junit.xml", xml: "<testsuites/>" }],
    },
  };
}

function results(stepSeq: number, callIds: string[]) {
  return {
    stepSeq,
    toolResults: callIds.map((callId) => ({ callId, ok: true, output: `result of ${callId}` })),
  };
}

type StepRequest = ReturnType<typeof start> | ReturnType<typeof results>;

/** A RUNNING attempt with its session open, and helpers bound to it. */
async function running(options: { maxIterations?: number } = {}) {
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
  const ref = {
    attemptId: attempt.id,
    githubRepoId: repo.githubRepoId,
    githubOwnerId: org.githubAccountId,
  };
  await sessions.open(ref, { tokenHash: hex(), now: new Date() });
  const steps = system.attempts;
  return {
    ref,
    attemptId: attempt.id,
    accept: (request: StepRequest | object, requestHash = hex()) =>
      steps.acceptStep(attempt.id, {
        request: request as StepRequest,
        requestHash,
        now: new Date(),
        maxIterations: options.maxIterations ?? 10,
      }),
    calls: (stepSeq: number, ids: string[]) =>
      steps.completeTurn(attempt.id, stepSeq, {
        toolCalls: ids.map((callId) => ({ callId, tool: "list_files" as const, path: "." })),
        model: MODEL,
      }),
    finish: (stepSeq: number, done: "submit" | "gave_up" | "stopped", reason = "because") =>
      steps.completeTurn(attempt.id, stepSeq, { done, reason, model: MODEL }),
    submit: (files: { path: string; content: string }[], requestHash = "c".repeat(64)) =>
      steps.acceptSubmission(attempt.id, {
        requestHash,
        files,
        checks: [{ name: "test", exitCode: 0, output: "2 passed" }],
        afterTests: { available: true, tests: [["cart::totals", ["passed"]]] },
      }),
    step: (stepSeq: number) => steps.getStep(attempt.id, stepSeq),
    history: () => steps.history(attempt.id),
    attempt: () => db.healAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
  };
}

describe("acceptStep", () => {
  it("runs a loop: start, calls, results, more calls, submit", async () => {
    const loop = await running();

    expect(await loop.accept(start())).toMatchObject({ result: "accepted", queueTurn: true });
    await loop.calls(1, ["c1", "c2"]);
    expect(await loop.step(1)).toMatchObject({
      status: "READY",
      toolCalls: [{ callId: "c1" }, {}],
    });
    expect(await loop.accept(results(2, ["c2", "c1"]))).toMatchObject({ result: "accepted" });
    await loop.calls(2, ["c3"]);
    await loop.accept(results(3, ["c3"]));
    await loop.finish(3, "submit", "fixed the total");

    expect(await loop.step(3)).toMatchObject({
      status: "DONE",
      outcome: "submit",
      reason: "fixed the total",
    });
    expect(await loop.attempt()).toMatchObject({
      status: "AWAITING_SUBMISSION",
      iterations: 3,
      finishedAt: null,
    });
    const history = await loop.history();
    expect(history.map((event) => event.type)).toEqual([
      "INFO",
      "MODEL_CALL",
      "TOOL_CALL",
      "TOOL_CALL",
      "TOOL_RESULT",
      "TOOL_RESULT",
      "MODEL_CALL",
      "TOOL_CALL",
      "TOOL_RESULT",
      "MODEL_CALL",
    ]);
    // The start event keeps report sizes, not their contents.
    expect(history[0]?.payload).toMatchObject({
      kind: "start",
      reports: [{ path: "reports/junit.xml", chars: 13 }],
    });
  });

  it("treats a retry with the same body as a duplicate, and another body as a conflict", async () => {
    const loop = await running();
    const hash = hex();

    await loop.accept(start(), hash);

    expect(await loop.accept(start(), hash)).toMatchObject({ result: "duplicate" });
    expect(await loop.accept(start(), hex())).toEqual({
      result: "conflict",
      reason: "this step was already sent with other content",
    });
    expect(await loop.history()).toHaveLength(1);
  });

  it("refuses a first step that doesn't start, and a skipped step", async () => {
    const loop = await running();

    expect(await loop.accept(results(1, ["c1"]))).toEqual({
      result: "conflict",
      reason: "no tool calls are waiting for results",
    });
    expect(await loop.accept({ ...start(), stepSeq: 2 })).toEqual({
      result: "conflict",
      reason: "expected step 1",
    });
  });

  it("refuses results before the model asked, or for other calls", async () => {
    const loop = await running();
    await loop.accept(start());

    expect(await loop.accept(results(2, ["c1"]))).toEqual({
      result: "conflict",
      reason: "no tool calls are waiting for results",
    });
    await loop.calls(1, ["c1", "c2"]);
    for (const ids of [["c1"], ["c1", "c9"], ["c1", "c1"], ["c1", "c2", "c3"]]) {
      expect(await loop.accept(results(2, ids))).toEqual({
        result: "conflict",
        reason: "the results don't answer the previous step's tool calls",
      });
    }
    // A second start answers nothing.
    expect(await loop.accept({ ...start(), stepSeq: 2 })).toMatchObject({ result: "conflict" });
  });

  it("ends without a model turn when the failure doesn't reproduce", async () => {
    const loop = await running();

    expect(await loop.accept(start(false))).toMatchObject({
      result: "accepted",
      queueTurn: false,
      step: { status: "DONE", outcome: "not_reproducible" },
    });
    const attempt = await loop.attempt();
    expect(attempt).toMatchObject({ status: "NOT_REPRODUCIBLE", iterations: 0 });
    expect(attempt.finishedAt).not.toBeNull();
    expect(await loop.accept(results(2, ["c1"]))).toEqual({
      result: "conflict",
      reason: "the attempt isn't running",
    });
  });

  it("stops at the iteration cap", async () => {
    const loop = await running({ maxIterations: 1 });
    await loop.accept(start());
    await loop.calls(1, ["c1"]);

    expect(await loop.accept(results(2, ["c1"]))).toMatchObject({
      result: "accepted",
      queueTurn: false,
      step: { status: "DONE", outcome: "stopped", reason: "iteration cap reached" },
    });
    expect(await loop.attempt()).toMatchObject({ status: "FAILED", iterations: 1 });
  });

  it("refuses steps once the session expired or was contested", async () => {
    const expired = await running();
    // Written directly as setup: time passing.
    await db.healAttempt.update({
      where: { id: expired.attemptId },
      data: { sessionExpiresAt: new Date(Date.now() - 1_000) },
    });
    const contested = await running();
    await sessions.contest(contested.ref, { now: new Date(), reason: "test" });

    expect(await expired.accept(start())).toEqual({
      result: "conflict",
      reason: "the session has expired",
    });
    expect(await contested.accept(start())).toEqual({
      result: "conflict",
      reason: "the attempt isn't running",
    });
  });
});

describe("completeTurn", () => {
  it("completes a turn once", async () => {
    const loop = await running();
    await loop.accept(start());

    await loop.calls(1, ["c1"]);
    const again = await loop.finish(1, "gave_up");

    expect(again).toMatchObject({ status: "READY", toolCalls: [{ callId: "c1" }] });
    expect(await loop.attempt()).toMatchObject({ status: "RUNNING", iterations: 1 });
  });

  it.each([
    ["gave_up", "GAVE_UP"],
    ["stopped", "FAILED"],
  ] as const)("ends the attempt on %s", async (done, status) => {
    const loop = await running();
    await loop.accept(start());

    await loop.finish(1, done, "needs a secret");

    const attempt = await loop.attempt();
    expect(attempt).toMatchObject({ status, endReason: "needs a secret" });
    expect(attempt.finishedAt).not.toBeNull();
  });

  it("ends the step when the attempt stopped while the model was thinking", async () => {
    const loop = await running();
    await loop.accept(start());
    await sessions.contest(loop.ref, { now: new Date(), reason: "test" });

    const step = await loop.calls(1, ["c1"]);

    expect(step).toMatchObject({ status: "DONE", outcome: "stopped", toolCalls: null });
    expect(await loop.attempt()).toMatchObject({ status: "FAILED", iterations: 0 });
  });

  it("refuses tool calls the protocol doesn't allow", async () => {
    const loop = await running();
    await loop.accept(start());

    await expect(loop.calls(1, ["c1", "c1"])).rejects.toThrow();
    await expect(loop.calls(1, [])).rejects.toThrow();
    await expect(loop.step(1)).resolves.toMatchObject({ status: "PENDING" });
  });
});

describe("races and state changes (P4.3 security review)", () => {
  it("lets one of two simultaneous turns win, without duplicating anything", async () => {
    const loop = await running();
    await loop.accept(start());

    const views = await Promise.all([loop.calls(1, ["a1"]), loop.calls(1, ["b1"])]);

    const ids = views.map((view) => view.toolCalls?.[0]?.callId);
    expect(new Set(ids).size).toBe(1);
    const history = await loop.history();
    expect(history.filter((event) => event.type === "MODEL_CALL")).toHaveLength(1);
    expect(history.filter((event) => event.type === "TOOL_CALL")).toHaveLength(1);
    expect(await loop.attempt()).toMatchObject({ iterations: 1, status: "RUNNING" });
  });

  it("answers the loser of two simultaneous step POSTs with a conflict", async () => {
    const loop = await running();

    const results = await Promise.all([loop.accept(start()), loop.accept(start())]);

    expect(results.map((result) => result.result).sort()).toEqual(["accepted", "conflict"]);
  });

  it("ends the attempt when its session expired while the model was thinking", async () => {
    const loop = await running();
    await loop.accept(start());
    // Written directly as setup: time passing.
    await db.healAttempt.update({
      where: { id: loop.attemptId },
      data: { sessionExpiresAt: new Date(Date.now() - 1_000) },
    });

    const step = await loop.calls(1, ["c1"]);

    expect(step).toMatchObject({
      status: "DONE",
      outcome: "stopped",
      reason: "the session expired",
    });
    expect(await loop.attempt()).toMatchObject({
      status: "FAILED",
      endReason: "the session expired",
    });
  });

  it("stops the loop when the organization or repository is disabled mid-attempt", async () => {
    const loop = await running();
    await loop.accept(start());
    await loop.calls(1, ["c1"]);
    const attempt = await db.healAttempt.findUniqueOrThrow({
      where: { id: loop.attemptId },
      include: { failure: true },
    });
    // Written directly as setup: an admin disabling the repository.
    await db.repository.update({ where: { id: attempt.failure.repoId }, data: { enabled: false } });

    expect(await loop.accept(results(2, ["c1"]))).toMatchObject({
      result: "accepted",
      queueTurn: false,
      step: { status: "DONE", outcome: "stopped" },
    });
    expect(await loop.attempt()).toMatchObject({ status: "FAILED" });
  });
});

describe("policy checks and the brief (P4.4)", () => {
  it("stores the turn's policy checks before the model's answer", async () => {
    const loop = await running();
    await loop.accept(start());
    await loop.calls(1, ["c1"]);
    await loop.accept(results(2, ["c1"]));

    const steps = await forSystem(db, (await loop.attempt()).orgId, "test");
    await steps.attempts.completeTurn(loop.attemptId, 2, {
      toolCalls: [{ callId: "c2", tool: "list_files", path: "." }],
      model: MODEL,
      policyChecks: [
        {
          callId: "c1",
          violations: [{ ruleId: "tests.mode", message: "edits a test", path: "a.test.ts" }],
        },
      ],
    });

    const types = (await loop.history()).map((event) => event.type);
    expect(types.slice(-3)).toEqual(["POLICY_CHECK", "MODEL_CALL", "TOOL_CALL"]);
    const check = (await loop.history()).find((event) => event.type === "POLICY_CHECK");
    expect(check?.payload).toEqual({
      callId: "c1",
      violations: [{ ruleId: "tests.mode", message: "edits a test", path: "a.test.ts" }],
    });
  });

  it("briefs the healer: the attempt, its repository, the failure and its jobs", async () => {
    const loop = await running();
    const attempt = await loop.attempt();
    const system = await forSystem(db, attempt.orgId, "test");

    const brief = await system.attempts.brief(loop.attemptId);

    expect(brief).toMatchObject({
      id: loop.attemptId,
      failingCheck: "test",
      failure: {
        headBranch: "main",
        repo: { defaultBranch: "main" },
        // Only jobs with an error window: none is triaged yet here.
        runs: [{ jobs: [] }],
      },
    });
    await expect(system.attempts.brief(randomUUID())).resolves.toBeNull();
    // Once triaged, the job's window shows. Written directly as setup.
    await db.failedJob.updateMany({
      where: { failedRun: { failureId: attempt.failureId } },
      data: { errorWindow: "FAIL cart" },
    });
    const triaged = await system.attempts.brief(loop.attemptId);
    expect(triaged?.failure.runs[0]?.jobs).toEqual([
      { name: "check", failedStep: "Test", summary: null, errorWindow: "FAIL cart" },
    ]);
  });
});

describe("runnerSessions.authenticate", () => {
  it("finds the attempt for its session token's hash while the session lasts", async () => {
    const loop = await running();
    const stored = await loop.attempt();
    const hash = stored.sessionTokenHash ?? "";

    expect(await sessions.authenticate(hash, new Date())).toMatchObject({
      attemptId: loop.attemptId,
      status: "RUNNING",
    });
    const later = new Date((stored.sessionExpiresAt ?? new Date()).getTime() + 1);
    expect(await sessions.authenticate(hash, later)).toBeNull();
    expect(await sessions.authenticate("nope", new Date())).toBeNull();
  });
});

describe("acceptSubmission", () => {
  const file = { path: "src/cart.ts", content: "export const total = 2;" };

  /** An attempt whose model just submitted a fix. */
  async function awaiting() {
    const loop = await running();
    await loop.accept(start());
    await loop.finish(1, "submit", "fixed the total");
    return loop;
  }

  it("stores the submission once, and the attempt is VALIDATING", async () => {
    const loop = await awaiting();

    await expect(loop.submit([file])).resolves.toEqual({ result: "accepted" });

    expect(await loop.attempt()).toMatchObject({ status: "VALIDATING" });
    const stored = await db.attemptSubmission.findUniqueOrThrow({
      where: { attemptId: loop.attemptId },
    });
    expect(stored).toMatchObject({
      files: [file],
      afterTests: { available: true, tests: [["cart::totals", ["passed"]]] },
    });
    const history = await loop.history();
    expect(history.at(-1)?.payload).toMatchObject({ kind: "submission", files: 1, tests: 1 });
  });

  it("treats a retried upload as the same submission, and refuses a different one", async () => {
    const loop = await awaiting();
    await loop.submit([file]);

    await expect(loop.submit([file])).resolves.toEqual({ result: "duplicate" });
    await expect(loop.submit([file], "d".repeat(64))).resolves.toEqual({
      result: "conflict",
      reason: "a submission was already received",
    });
  });

  it("refuses an attempt that isn't waiting for one, and a path sent twice", async () => {
    const loop = await running();
    await loop.accept(start());

    await expect(loop.submit([file])).resolves.toEqual({
      result: "conflict",
      reason: "the attempt isn't waiting for a submission",
    });
    const waiting = await awaiting();
    await expect(waiting.submit([file, file])).resolves.toEqual({
      result: "conflict",
      reason: "a path appears twice",
    });
    expect(await db.attemptSubmission.count({ where: { attemptId: loop.attemptId } })).toBe(0);
  });
});
