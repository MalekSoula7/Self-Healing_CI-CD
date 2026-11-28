// Needs Postgres: `docker compose up -d`. The reconciler's database side (SPEC §2.2, P5.3b).
// Other test files share the database, so every assertion looks only at this test's own rows.
import { randomInt, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { installations } from "./installations";
import { reconciliation } from "./reconciliation";
import { forSystem } from "./scope";
import { createTestDb } from "./testing";

const db = createTestDb();
const githubId = () => BigInt(randomInt(1, 2 ** 47));
const sha = () => randomUUID().replaceAll("-", "").padEnd(40, "0");
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const ALL = 1_000_000;

/** A claimed (HEALING) failure with its DISPATCHED attempt. */
async function dispatched() {
  const login = `R${randomUUID().replaceAll("-", "").slice(0, 20)}`;
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
    headSha: sha(),
    headBranch: "main",
    runId,
    runAttempt: 1,
    workflowId: 11n,
    workflowName: "CI",
    workflowPath: ".github/workflows/ci.yml",
    conclusion: "failure",
    htmlUrl: null,
    jobs: [{ githubJobId: githubId(), name: "check", failedStep: "Test", htmlUrl: null }],
  });
  await system.failures.recordTriage(failure.id, {
    category: "test",
    confidence: 0.9,
    summary: "A test failed.",
  });
  const claim = await system.attempts.claimDispatch({
    failureId: failure.id,
    failingCheck: "test",
    maxAttemptsPerFailure: 5,
    maxAttemptsPerDay: 20,
  });
  if (claim.outcome !== "created") throw new Error("test setup: not claimed");
  const attemptId = claim.attempt.id;
  const set = (data: Parameters<typeof db.healAttempt.update>[0]["data"]) =>
    db.healAttempt.update({ where: { id: attemptId }, data });
  const failureStatus = async () => (await system.failures.get(failure.id))?.status;
  const stored = () => db.healAttempt.findUniqueOrThrow({ where: { id: attemptId } });
  const ref = { orgId: org.id, attemptId };
  return { org, system, failure, runId, attemptId, set, stored, failureStatus, ref };
}

describe("reconciliation.due", () => {
  it("lists a dispatch past its timeout and a session past its end, not live ones", async () => {
    const late = await dispatched();
    await late.set({ dispatchedAt: ago(16) });
    const fresh = await dispatched();
    const ended = await dispatched();
    await ended.set({ status: "RUNNING", sessionOpenedAt: ago(50), sessionExpiresAt: ago(5) });
    const live = await dispatched();
    await live.set({ status: "RUNNING", sessionOpenedAt: ago(5), sessionExpiresAt: ago(-5) });

    const due = await reconciliation(db).due(new Date(), ALL);
    const ids = due.expired.map((row) => row.attemptId);

    expect(ids).toEqual(expect.arrayContaining([late.attemptId, ended.attemptId]));
    expect(ids).not.toContain(fresh.attemptId);
    expect(ids).not.toContain(live.attemptId);
  });

  it("lists stuck validations, publishes and open pull requests once they are old", async () => {
    const stuck = await dispatched();
    await stuck.set({ status: "VALIDATING", updatedAt: ago(11) });
    const publishing = await dispatched();
    await publishing.set({ status: "PUBLISHING", updatedAt: ago(16) });
    const opened = await dispatched();
    await opened.set({ status: "PR_OPENED", prOpenedAt: ago(11) });
    const recent = await dispatched();
    await recent.set({ status: "VALIDATED" });

    const due = await reconciliation(db).due(new Date(), ALL);

    expect(due.submissions).toContainEqual(
      expect.objectContaining({ ...stuck.ref, status: "VALIDATING" }),
    );
    expect(due.submissions.map((row) => row.attemptId)).not.toContain(recent.attemptId);
    expect(due.publishing).toContainEqual(expect.objectContaining(publishing.ref));
    expect(due.opened).toContainEqual(expect.objectContaining(opened.ref));
  });

  it("returns only IDs, statuses and times", async () => {
    const late = await dispatched();
    await late.set({ dispatchedAt: ago(16) });

    const due = await reconciliation(db).due(new Date(), ALL);
    const row = due.expired.find((item) => item.attemptId === late.attemptId);

    expect(Object.keys(row ?? {}).sort()).toEqual(["attemptId", "orgId", "since"]);
  });

  it("lists a flaky re-run that never reported", async () => {
    const f = await dispatched();
    const run = await db.failedRun.findFirstOrThrow({ where: { failureId: f.failure.id } });
    await db.failedRun.update({
      where: { id: run.id },
      data: { rerunByUs: true, rerunFromAttempt: 1, updatedAt: ago(7 * 60) },
    });
    await db.pipelineFailure.update({ where: { id: f.failure.id }, data: { status: "TRIAGED" } });

    const due = await reconciliation(db).due(new Date(), ALL);

    expect(due.reruns).toContainEqual({ orgId: f.org.id, failureId: f.failure.id });
  });
});

describe("reconciliation.due: re-runs", () => {
  it("never lists a re-run that reported, so it can't crowd out a silent one", async () => {
    const reported = await dispatched();
    const silent = await dispatched();
    for (const [f, runAttempt, updatedAt] of [
      [reported, 2, ago(9 * 60)],
      [silent, 1, ago(7 * 60)],
    ] as const) {
      await db.failedRun.updateMany({
        where: { failureId: f.failure.id },
        data: { rerunByUs: true, rerunFromAttempt: 1, runAttempt, updatedAt },
      });
      await db.pipelineFailure.update({ where: { id: f.failure.id }, data: { status: "TRIAGED" } });
    }

    const due = await reconciliation(db).due(new Date(), ALL);

    expect(due.reruns.map((row) => row.failureId)).not.toContain(reported.failure.id);
    expect(due.reruns).toContainEqual({ orgId: silent.org.id, failureId: silent.failure.id });
  });
});

describe("attempts.expire", () => {
  it("fails a dispatch whose healer never started, and its failure", async () => {
    const f = await dispatched();
    await f.set({ dispatchedAt: ago(16) });

    await expect(f.system.attempts.expire(f.attemptId, new Date())).resolves.toBe(
      "the healer never started",
    );

    expect(await f.stored()).toMatchObject({ status: "FAILED" });
    await expect(f.failureStatus()).resolves.toBe("FAILED");
    await expect(f.system.attempts.expire(f.attemptId, new Date())).resolves.toBeNull();
  });

  it("fails an attempt whose session ran out and revokes the session", async () => {
    const f = await dispatched();
    await f.set({
      status: "AWAITING_SUBMISSION",
      sessionOpenedAt: ago(50),
      sessionExpiresAt: ago(5),
      sessionTokenHash: sha() + sha().slice(0, 24),
    });

    await expect(f.system.attempts.expire(f.attemptId, new Date())).resolves.toBe(
      "the healer's session ended before it finished",
    );
    expect(await f.stored()).toMatchObject({ status: "FAILED", sessionTokenHash: null });
  });

  it("leaves an attempt that is on time, or past the runner's part", async () => {
    const onTime = await dispatched();
    const validating = await dispatched();
    await validating.set({ status: "VALIDATING", sessionExpiresAt: ago(60) });

    await expect(onTime.system.attempts.expire(onTime.attemptId, new Date())).resolves.toBeNull();
    await expect(
      validating.system.attempts.expire(validating.attemptId, new Date()),
    ).resolves.toBeNull();
    await expect(onTime.failureStatus()).resolves.toBe("HEALING");
  });
});

describe("attempts.settleFailure", () => {
  it.each([
    ["GAVE_UP", "NEEDS_HUMAN"],
    ["NOT_REPRODUCIBLE", "NOT_REPRODUCIBLE"],
    ["REJECTED", "FAILED"],
    ["FAILED", "FAILED"],
  ] as const)("a %s attempt leaves its failure %s", async (status, expected) => {
    const f = await dispatched();
    await f.set({ status });
    const due = await reconciliation(db).due(new Date(), ALL);

    expect(due.unsettled.map((row) => row.attemptId)).toContain(f.attemptId);
    await expect(f.system.attempts.settleFailure(f.attemptId)).resolves.toBe(true);
    await expect(f.failureStatus()).resolves.toBe(expected);
    await expect(f.system.attempts.settleFailure(f.attemptId)).resolves.toBe(false);
  });

  it("leaves the failure to a newer attempt, and to an attempt still running", async () => {
    const f = await dispatched();
    await expect(f.system.attempts.settleFailure(f.attemptId)).resolves.toBe(false);
    await f.set({ status: "GAVE_UP" });
    await f.system.attempts.create({
      failureId: f.failure.id,
      targetSha: f.failure.headSha,
      failingCheck: "test",
    });

    await expect(f.system.attempts.settleFailure(f.attemptId)).resolves.toBe(false);
    await expect(f.failureStatus()).resolves.toBe("HEALING");
  });
});
