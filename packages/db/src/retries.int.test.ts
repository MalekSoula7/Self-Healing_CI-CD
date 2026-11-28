// Needs Postgres: `docker compose up -d`. The retry after failed CI (SPEC §9.1, P5.3d): claiming
// it under the caps, reading the attempts it builds on, and what a retry that ends leaves behind.
import { randomInt, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { installations } from "./installations";
import { forSystem } from "./scope";
import { createTestDb } from "./testing";

const db = createTestDb();
const githubId = () => BigInt(randomInt(1, 2 ** 47));
const sha = () => randomUUID().replaceAll("-", "").padEnd(40, "0");
const FEEDBACK = [{ name: "check", failedStep: "Test", summary: null, errorWindow: "boom" }];

/** An attempt whose CI failed: the failure NEEDS_HUMAN, PipeHeal's commit on its branch. */
async function ciFailed() {
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
  const fail = async () =>
    (
      await system.failures.recordFailedRun(repo.id, {
        headSha: sha(),
        headBranch: "main",
        runId: githubId(),
        runAttempt: 1,
        workflowId: 11n,
        workflowName: "CI",
        workflowPath: ".github/workflows/ci.yml",
        conclusion: "failure",
        htmlUrl: null,
        jobs: [{ githubJobId: githubId(), name: "check", failedStep: "Test", htmlUrl: null }],
      })
    ).failure;
  const failure = await fail();
  const first = await system.attempts.create({
    failureId: failure.id,
    targetSha: failure.headSha,
    failingCheck: "test",
  });
  const commitSha = sha();
  await db.healAttempt.update({
    where: { id: first.id },
    data: {
      status: "CI_FAILED",
      branch: "pipeheal/abc-1",
      commitSha,
      prNumber: 7,
      baselineTests: { available: false, reason: "first baseline" },
    },
  });
  await db.attemptSubmission.create({
    data: {
      orgId: org.id,
      attemptId: first.id,
      requestHash: "e".repeat(64),
      files: [{ path: "src/a.ts", content: "one" }],
      checks: [],
      afterTests: { available: false, reason: "none" },
    },
  });
  await db.pipelineFailure.update({ where: { id: failure.id }, data: { status: "NEEDS_HUMAN" } });
  const claim = (overrides: { perFailure?: number; perDay?: number } = {}) =>
    system.attempts.claimRetry({
      previousAttemptId: first.id,
      failingCheck: "lint",
      feedback: FEEDBACK,
      maxAttemptsPerFailure: overrides.perFailure ?? 2,
      maxAttemptsPerDay: overrides.perDay ?? 20,
    });
  const failureStatus = async () => (await system.failures.get(failure.id))?.status;
  return { org, system, repo, failure, first, commitSha, claim, fail, failureStatus };
}

describe("attempts.claimRetry", () => {
  it("creates the next attempt on PipeHeal's commit, and the failure heals again", async () => {
    const f = await ciFailed();

    const result = await f.claim();

    expect(result).toMatchObject({
      outcome: "created",
      attempt: {
        attemptNo: 2,
        status: "DISPATCHED",
        targetSha: f.commitSha,
        failingCheck: "lint",
        retryOfId: f.first.id,
        feedback: FEEDBACK,
      },
    });
    await expect(f.failureStatus()).resolves.toBe("HEALING");
  });

  it("claims once: a second call finds the failure healing", async () => {
    const f = await ciFailed();
    await f.claim();

    await expect(f.claim()).resolves.toMatchObject({ outcome: "not_ready" });
  });

  it.each(["VERIFIED", "UNVERIFIED", "PR_OPENED"] as const)(
    "doesn't retry a %s attempt",
    async (status) => {
      const f = await ciFailed();
      await db.healAttempt.update({ where: { id: f.first.id }, data: { status } });

      await expect(f.claim()).resolves.toMatchObject({ outcome: "not_ready" });
    },
  );

  it("doesn't retry for a disabled repository", async () => {
    const f = await ciFailed();
    await f.system.repositories.setEnabled(f.repo.id, false);

    await expect(f.claim()).resolves.toMatchObject({ outcome: "not_ready" });
  });

  it("stops at the failure's cap and the organization's daily cap", async () => {
    const f = await ciFailed();

    await expect(f.claim({ perFailure: 1 })).resolves.toMatchObject({ outcome: "capped" });
    await expect(f.claim({ perDay: 1 })).resolves.toMatchObject({ outcome: "capped" });
    await expect(f.failureStatus()).resolves.toBe("NEEDS_HUMAN");
  });

  it("waits while the repository has another attempt in flight", async () => {
    const f = await ciFailed();
    const other = await f.fail();
    await f.system.attempts.create({
      failureId: other.id,
      targetSha: other.headSha,
      failingCheck: "test",
    });

    await expect(f.claim()).resolves.toEqual({ outcome: "busy" });
  });

  it("refuses feedback that doesn't fit", async () => {
    const f = await ciFailed();

    await expect(
      f.system.attempts.claimRetry({
        previousAttemptId: f.first.id,
        failingCheck: "test",
        feedback: [
          { name: "check", failedStep: null, summary: null, errorWindow: "x".repeat(200_001) },
        ],
        maxAttemptsPerFailure: 2,
        maxAttemptsPerDay: 20,
      }),
    ).rejects.toThrow();
  });
});

describe("attempts.chain", () => {
  it("gives the original commit, the first baseline and the earlier files, oldest first", async () => {
    const f = await ciFailed();
    const result = await f.claim();
    if (result.outcome !== "created") throw new Error("test setup: not claimed");

    await expect(f.system.attempts.chain(result.attempt.id)).resolves.toMatchObject({
      originalSha: f.failure.headSha,
      baselineTests: { available: false, reason: "first baseline" },
      earlierFiles: [[{ path: "src/a.ts", content: "one" }]],
      previous: {
        id: f.first.id,
        status: "CI_FAILED",
        branch: "pipeheal/abc-1",
        commitSha: f.commitSha,
        prNumber: 7,
      },
    });
  });

  it("is null for an attempt that retries nothing, or when an earlier upload is missing", async () => {
    const f = await ciFailed();
    await expect(f.system.attempts.chain(f.first.id)).resolves.toBeNull();
    const result = await f.claim();
    if (result.outcome !== "created") throw new Error("test setup: not claimed");
    await db.attemptSubmission.deleteMany({ where: { attemptId: f.first.id } });

    await expect(f.system.attempts.chain(result.attempt.id)).resolves.toBeNull();
  });
});

describe("a retry that ends without a commit leaves the failure to a person", () => {
  async function retrying() {
    const f = await ciFailed();
    const result = await f.claim();
    if (result.outcome !== "created") throw new Error("test setup: not claimed");
    const id = result.attempt.id;
    const set = (data: Parameters<typeof db.healAttempt.update>[0]["data"]) =>
      db.healAttempt.update({ where: { id }, data });
    return { ...f, id, set };
  }

  it("when its dispatch fails", async () => {
    const f = await retrying();

    await f.system.attempts.failDispatch(f.id, { reason: "x", failureStatus: "FAILED" });

    await expect(f.failureStatus()).resolves.toBe("NEEDS_HUMAN");
  });

  it("when it is rejected", async () => {
    const f = await retrying();
    await f.set({ status: "VALIDATING" });

    await f.system.attempts.recordValidation(f.id, {
      passed: false,
      reasons: ["no"],
      violations: [],
      behavior: { available: false, reason: null },
      checks: [],
      judge: [],
      draftReasons: [],
      changedFiles: 0,
      digest: null,
    });

    await expect(f.failureStatus()).resolves.toBe("NEEDS_HUMAN");
  });

  it("when publishing fails", async () => {
    const f = await retrying();
    await f.set({ status: "PUBLISHING", branch: "pipeheal/abc-1" });

    await f.system.attempts.failPublish(f.id, "x");

    await expect(f.failureStatus()).resolves.toBe("NEEDS_HUMAN");
  });

  it("when it expires", async () => {
    const f = await retrying();

    await f.system.attempts.expire(f.id, new Date(Date.now() + 60 * 60_000));

    await expect(f.failureStatus()).resolves.toBe("NEEDS_HUMAN");
  });

  it("when it gives up", async () => {
    const f = await retrying();
    await f.set({ status: "NOT_REPRODUCIBLE" });

    await f.system.attempts.settleFailure(f.id);

    await expect(f.failureStatus()).resolves.toBe("NEEDS_HUMAN");
  });
});
