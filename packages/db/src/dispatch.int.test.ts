// Needs Postgres: `docker compose up -d`. The dispatcher's database side (P4.8, D18): claiming a
// triaged failure under its caps, settling one at its diagnosis, and failing a dispatch.
import { randomInt, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { installations } from "./installations";
import { forSystem } from "./scope";
import { createTestDb } from "./testing";

const db = createTestDb();
const githubId = () => BigInt(randomInt(1, 2 ** 47));
const sha = () => randomUUID().replaceAll("-", "").padEnd(40, "0");

/** An org with two repositories; `fail()` records (and triages) a new failure in one. */
async function tenant() {
  const login = `D${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const org = await installations(db, "test").upsert({
    githubAccountId: githubId(),
    login,
    accountType: "ORG",
    installationId: githubId(),
  });
  const system = await forSystem(db, org.id, "test");
  const [repo, other] = await system.repositories.syncInstalled([
    { githubRepoId: githubId(), fullName: `${login}/app`, defaultBranch: "main" },
    { githubRepoId: githubId(), fullName: `${login}/lib`, defaultBranch: "main" },
  ]);
  if (repo === undefined || other === undefined) throw new Error("test setup: no repository");
  await system.repositories.setEnabled(repo.id, true);
  await system.repositories.setEnabled(other.id, true);

  async function fail(repoId: string = repo?.id ?? "", triage = true) {
    const runId = githubId();
    const { failure } = await system.failures.recordFailedRun(repoId, {
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
    if (triage) {
      await system.failures.recordTriage(failure.id, {
        category: "test",
        confidence: 0.9,
        summary: "A test failed.",
      });
    }
    return failure;
  }

  const claim = (failureId: string, caps: { perFailure?: number; perDay?: number } = {}) =>
    system.attempts.claimDispatch({
      failureId,
      failingCheck: "test",
      maxAttemptsPerFailure: caps.perFailure ?? 2,
      maxAttemptsPerDay: caps.perDay ?? 20,
    });

  return { system, repo, other, fail, claim };
}

describe("attempts.claimDispatch", () => {
  it("creates attempt 1 on the failure's head commit, and the failure is HEALING", async () => {
    const { system, fail, claim } = await tenant();
    const failure = await fail();

    const result = await claim(failure.id);

    expect(result).toMatchObject({
      outcome: "created",
      attempt: {
        attemptNo: 1,
        status: "DISPATCHED",
        targetSha: failure.headSha,
        failingCheck: "test",
      },
    });
    expect((await system.failures.get(failure.id))?.status).toBe("HEALING");
  });

  it("only claims a TRIAGED failure", async () => {
    const { fail, claim } = await tenant();
    const detected = await fail(undefined, false);
    const healing = await fail();
    await claim(healing.id);

    await expect(claim(detected.id)).resolves.toEqual({ outcome: "not_ready", status: "DETECTED" });
    await expect(claim(healing.id)).resolves.toEqual({ outcome: "not_ready", status: "HEALING" });
  });

  it("waits while the repository has an attempt in flight; other repositories go on", async () => {
    const { other, fail, claim } = await tenant();
    await claim((await fail()).id);

    await expect(claim((await fail()).id)).resolves.toEqual({ outcome: "busy" });
    await expect(claim((await fail(other.id)).id)).resolves.toMatchObject({ outcome: "created" });
  });

  it("doesn't claim for a disabled repository or while a re-run of ours is pending", async () => {
    const { system, repo, fail, claim } = await tenant();
    const pending = await fail();
    const run = (await system.failures.get(pending.id))?.runs[0];
    if (run === undefined) throw new Error("test setup: no run");
    await system.failures.claimRerun(run.id);

    await expect(claim(pending.id)).resolves.toMatchObject({ outcome: "not_ready" });
    const later = await fail();
    await system.repositories.setEnabled(repo.id, false);
    await expect(claim(later.id)).resolves.toMatchObject({ outcome: "not_ready" });
  });

  it("doesn't count a dispatch past its timeout, or an expired session, as in flight", async () => {
    const { fail, claim } = await tenant();
    const stuck = await claim((await fail()).id);
    if (stuck.outcome !== "created") throw new Error("test setup: no attempt");
    await db.healAttempt.update({
      where: { id: stuck.attempt.id },
      data: { dispatchedAt: new Date(Date.now() - 16 * 60_000) },
    });
    const expired = await claim((await fail()).id);
    if (expired.outcome !== "created") throw new Error("test setup: not claimed");
    await db.healAttempt.update({
      where: { id: expired.attempt.id },
      data: {
        status: "RUNNING",
        sessionOpenedAt: new Date(Date.now() - 50 * 60_000),
        sessionExpiresAt: new Date(Date.now() - 60_000),
      },
    });

    await expect(claim((await fail()).id)).resolves.toMatchObject({ outcome: "created" });
  });

  it("stops at the failure's attempt cap", async () => {
    const { system, fail, claim } = await tenant();
    const failure = await fail();
    const first = await claim(failure.id);
    if (first.outcome !== "created") throw new Error("test setup: no attempt");
    await system.attempts.failDispatch(first.attempt.id, { reason: "x", failureStatus: "FAILED" });
    // As if the failure were triaged again for a retry: only TRIAGED can be claimed.
    await db.pipelineFailure.update({ where: { id: failure.id }, data: { status: "TRIAGED" } });

    await expect(claim(failure.id, { perFailure: 1 })).resolves.toEqual({
      outcome: "capped",
      reason: "the failure's attempt cap is reached",
    });
  });

  it("stops at the organization's daily cap, across repositories", async () => {
    const { other, fail, claim } = await tenant();
    await claim((await fail()).id, { perDay: 1 });

    await expect(claim((await fail(other.id)).id, { perDay: 1 })).resolves.toEqual({
      outcome: "capped",
      reason: "the organization's daily attempt cap is reached",
    });
  });

  it("lets only one of two racing claims on a repository win", async () => {
    const { fail, claim } = await tenant();
    const one = await fail();
    const two = await fail();

    const results = await Promise.allSettled([claim(one.id), claim(two.id)]);
    const created = results.filter(
      (result) => result.status === "fulfilled" && result.value.outcome === "created",
    );

    // The loser is "busy", or its serializable transaction failed (its job retries).
    expect(created).toHaveLength(1);
  });

  it("refuses caps out of range", async () => {
    const { system, fail } = await tenant();
    const failure = await fail();

    await expect(
      system.attempts.claimDispatch({
        failureId: failure.id,
        failingCheck: "test",
        maxAttemptsPerFailure: 0,
        maxAttemptsPerDay: 20,
      }),
    ).rejects.toThrow();
  });
});

describe("attempts.failDispatch", () => {
  it("fails a dispatched attempt and sends the failure to setup", async () => {
    const { system, fail, claim } = await tenant();
    const failure = await fail();
    const result = await claim(failure.id);
    if (result.outcome !== "created") throw new Error("test setup: no attempt");

    const failed = await system.attempts.failDispatch(result.attempt.id, {
      reason: "the healer workflow is missing",
      failureStatus: "NEEDS_SETUP",
    });

    expect(failed).toMatchObject({ status: "FAILED", endReason: "the healer workflow is missing" });
    expect(failed.finishedAt).not.toBeNull();
    expect(await system.failures.get(failure.id)).toMatchObject({
      status: "NEEDS_SETUP",
      skipReason: "the healer workflow is missing",
    });
  });

  it("leaves an attempt alone once a runner has its session", async () => {
    const { system, fail, claim } = await tenant();
    const result = await claim((await fail()).id);
    if (result.outcome !== "created") throw new Error("test setup: no attempt");
    await db.healAttempt.update({
      where: { id: result.attempt.id },
      data: { status: "RUNNING", sessionOpenedAt: new Date() },
    });

    await expect(
      system.attempts.failDispatch(result.attempt.id, { reason: "x", failureStatus: "FAILED" }),
    ).resolves.toMatchObject({ status: "RUNNING" });
  });
});

describe("failures.settle", () => {
  it("settles a triaged failure with its reason, and nothing else", async () => {
    const { system, fail, claim } = await tenant();
    const triaged = await fail();
    const healing = await fail();
    await claim(healing.id);

    await expect(
      system.failures.settle(triaged.id, { status: "SKIPPED", reason: "branch out of scope" }),
    ).resolves.toMatchObject({ status: "SKIPPED", skipReason: "branch out of scope" });
    await expect(
      system.failures.settle(healing.id, { status: "SKIPPED", reason: "x" }),
    ).resolves.toMatchObject({ status: "HEALING", skipReason: null });
  });
});
