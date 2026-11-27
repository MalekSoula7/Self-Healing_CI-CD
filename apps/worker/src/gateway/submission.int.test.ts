// Needs Postgres: `docker compose up -d`. POST /v1/submission (P5.1b) against the real database: a
// runner whose attempt is waiting for its submission uploads the fix once.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { forSystem, installations, runnerSessions } from "@pipeheal/db";
import { createTestDb } from "@pipeheal/db/testing";
import { createLogger } from "@pipeheal/shared/logger";
import { describe, expect, it } from "vitest";
import { buildGateway } from "./server";
import { hashSessionToken } from "./session";
import { registerSubmissionRoute } from "./submission";

const db = createTestDb();
const logger = createLogger({ level: "silent", service: "test" });
const sessions = runnerSessions(db, "test");
const githubId = () => BigInt(randomInt(1, 2 ** 47));
const SECRET = `ghp_${"Q7w8E9r0T1".repeat(4)}`;

/** An attempt with an open session whose model submitted a fix, and the runner's token. */
async function awaiting(status: "AWAITING_SUBMISSION" | "RUNNING" = "AWAITING_SUBMISSION") {
  const login = `S${randomUUID().replaceAll("-", "").slice(0, 20)}`;
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
  const { failure } = await system.failures.recordFailedRun(repo.id, {
    headSha: randomUUID().replaceAll("-", "").padEnd(40, "0"),
    headBranch: "main",
    runId: githubId(),
    runAttempt: 1,
    workflowId: 11n,
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
    dispatchRunId: githubId(),
  });
  const token = randomBytes(32).toString("base64url");
  await sessions.open(
    { attemptId: attempt.id, githubRepoId: repo.githubRepoId, githubOwnerId: org.githubAccountId },
    { tokenHash: hashSessionToken(token), now: new Date() },
  );
  await db.healAttempt.update({ where: { id: attempt.id }, data: { status } });
  return { token, attemptId: attempt.id, orgId: org.id };
}

async function gateway() {
  const queued: { orgId: string; attemptId: string }[] = [];
  const app = await buildGateway({ logger });
  const state = registerSubmissionRoute(app, {
    sessions,
    attempts: async (orgId) => (await forSystem(db, orgId, "test")).attempts,
    enqueueValidation: (job) => {
      queued.push(job);
      return Promise.resolve();
    },
  });
  const upload = (token: string | null, body: unknown) =>
    app.inject({
      method: "POST",
      url: "/v1/submission",
      payload: body as object,
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });
  return { app, queued, state, upload };
}

const XML =
  '<testsuites><testsuite name="cart"><testcase classname="cart" name="totals"/>' +
  "</testsuite></testsuites>";

const SUBMISSION = {
  files: [
    { path: "src/cart.ts", content: "export const total = (a: number, b: number) => a + b;\n" },
    { path: "src/old.ts", deleted: true },
  ],
  checks: [{ name: "test", exitCode: 0, output: `1 passed; token ${SECRET}` }],
  reports: [{ path: "reports/junit.xml", xml: XML }],
};

describe("POST /v1/submission", () => {
  it("stores the fix, redacted and parsed, and queues its validation", async () => {
    const { token, attemptId, orgId } = await awaiting();
    const { app, queued, state, upload } = await gateway();

    const answer = await upload(token, SUBMISSION);
    await app.close();

    expect(answer.statusCode).toBe(202);
    expect(queued).toEqual([{ orgId, attemptId }]);
    expect(state.holding()).toEqual({ sessions: 0, bodies: 0 });
    await expect(
      db.healAttempt.findUniqueOrThrow({ where: { id: attemptId } }),
    ).resolves.toMatchObject({ status: "VALIDATING" });
    const stored = await db.attemptSubmission.findUniqueOrThrow({ where: { attemptId } });
    expect(stored.files).toEqual(SUBMISSION.files);
    expect(stored.afterTests).toEqual({ available: true, tests: [["cart::totals", ["passed"]]] });
    expect(JSON.stringify(stored.checks)).not.toContain(SECRET);
    expect(JSON.stringify(stored)).not.toContain("<testsuites>");
  });

  it("answers a retried upload like the first, and refuses a different one", async () => {
    const { token } = await awaiting();
    const { app, queued, upload } = await gateway();

    const first = await upload(token, SUBMISSION);
    const retry = await upload(token, SUBMISSION);
    const other = await upload(token, { ...SUBMISSION, checks: [] });
    await app.close();

    expect([first.statusCode, retry.statusCode, other.statusCode]).toEqual([202, 202, 409]);
    expect(queued).toHaveLength(2);
  });

  it("checks the session and the attempt's state before reading any body", async () => {
    const running = await awaiting("RUNNING");
    const { app, upload } = await gateway();

    const none = await upload(null, SUBMISSION);
    const wrong = await upload(randomBytes(32).toString("base64url"), SUBMISSION);
    const early = await upload(running.token, SUBMISSION);
    await app.close();

    expect([none.statusCode, wrong.statusCode, early.statusCode]).toEqual([401, 401, 409]);
    expect(await db.attemptSubmission.count({ where: { attemptId: running.attemptId } })).toBe(0);
  });

  it("refuses an invalid submission without storing anything", async () => {
    const { token, attemptId } = await awaiting();
    const { app, upload } = await gateway();

    const answers = [
      await upload(token, { ...SUBMISSION, files: [] }),
      await upload(token, { ...SUBMISSION, files: [{ path: "../etc/passwd", content: "x" }] }),
      await upload(token, { ...SUBMISSION, files: [SUBMISSION.files[0], SUBMISSION.files[0]] }),
      await upload(token, { ...SUBMISSION, diff: "--- a/x" }),
    ];
    await app.close();

    expect(answers.map((answer) => answer.statusCode)).toEqual([400, 400, 409, 400]);
    expect(await db.attemptSubmission.count({ where: { attemptId } })).toBe(0);
  });
});
