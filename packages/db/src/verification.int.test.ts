// Needs Postgres: `docker compose up -d`. Verification's database side (P5.3a): finding the attempt
// a CI run belongs to by PipeHeal's commit, and recording CI's verdict.
import { randomInt, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { installations } from "./installations";
import { forSystem } from "./scope";
import { createTestDb } from "./testing";

const db = createTestDb();
const githubId = () => BigInt(randomInt(1, 2 ** 47));
const sha = () => randomUUID().replaceAll("-", "").padEnd(40, "0");

/** An org with a repository and an attempt whose pull request is open on `commitSha`. */
async function opened() {
  const login = `Y${randomUUID().replaceAll("-", "").slice(0, 20)}`;
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
  const { failure } = await system.failures.recordFailedRun(repo.id, {
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
    number: 7,
    url: `https://github.com/${login}/app/pull/7`,
    draft: false,
  });
  const failureStatus = async () => (await system.failures.get(failure.id))?.status;
  const stored = () => db.healAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
  return { org, system, repo, other, failure, attempt, commitSha, branch, failureStatus, stored };
}

describe("attempts.forCommit", () => {
  it("finds the attempt by PipeHeal's commit, with what verifying needs", async () => {
    const { org, system, repo, attempt, commitSha, branch } = await opened();

    await expect(system.attempts.forCommit(repo.id, commitSha)).resolves.toMatchObject({
      id: attempt.id,
      status: "PR_OPENED",
      branch,
      commitSha,
      prNumber: 7,
      org: { installationId: org.installationId, status: "ACTIVE" },
      failure: { runs: [{ workflowId: 11n, conclusion: "failure" }] },
    });
  });

  it("finds nothing for another commit, another repository or a malformed value", async () => {
    const { system, repo, other, commitSha } = await opened();

    await expect(system.attempts.forCommit(repo.id, sha())).resolves.toBeNull();
    await expect(system.attempts.forCommit(other.id, commitSha)).resolves.toBeNull();
    await expect(system.attempts.forCommit(repo.id, "pipeheal/x-1")).resolves.toBeNull();
    await expect(system.attempts.forCommit("nope", commitSha)).resolves.toBeNull();
  });

  it("ignores an attempt without an open pull request", async () => {
    const { system, repo, attempt, commitSha } = await opened();
    await db.healAttempt.update({ where: { id: attempt.id }, data: { status: "PUBLISHING" } });

    await expect(system.attempts.forCommit(repo.id, commitSha)).resolves.toBeNull();
  });
});

describe("attempts.recordVerification", () => {
  it("records when the pull request was opened", async () => {
    const { stored } = await opened();

    expect((await stored()).prOpenedAt).toBeInstanceOf(Date);
  });

  it.each([
    ["verified", "VERIFIED", "VERIFIED"],
    ["failed", "CI_FAILED", "NEEDS_HUMAN"],
    ["unverified", "UNVERIFIED", "UNVERIFIED"],
  ] as const)(
    "%s: the attempt becomes %s and its failure %s",
    async (result, status, failureStatus) => {
      const fixture = await opened();

      await expect(
        fixture.system.attempts.recordVerification(fixture.attempt.id, { result, reason: "why" }),
      ).resolves.toEqual({ changed: true });

      expect(await fixture.stored()).toMatchObject({ status, endReason: "why" });
      expect((await fixture.stored()).finishedAt).not.toBeNull();
      await expect(fixture.failureStatus()).resolves.toBe(failureStatus);
    },
  );

  it("changes nothing the second time, so a comment is only posted once", async () => {
    const { system, attempt } = await opened();
    await system.attempts.recordVerification(attempt.id, { result: "failed" });

    await expect(
      system.attempts.recordVerification(attempt.id, { result: "failed" }),
    ).resolves.toEqual({ changed: false });
  });

  it("lets CI that reports late replace an earlier answer", async () => {
    const { system, attempt, failureStatus } = await opened();
    await system.attempts.recordVerification(attempt.id, { result: "unverified" });

    await system.attempts.recordVerification(attempt.id, { result: "failed" });
    await expect(failureStatus()).resolves.toBe("NEEDS_HUMAN");
    await system.attempts.recordVerification(attempt.id, { result: "verified" });
    await expect(failureStatus()).resolves.toBe("VERIFIED");
  });

  it("never downgrades CI's verdict to unverified", async () => {
    const { system, attempt, failureStatus } = await opened();
    await system.attempts.recordVerification(attempt.id, { result: "verified" });

    await expect(
      system.attempts.recordVerification(attempt.id, { result: "unverified" }),
    ).resolves.toEqual({ changed: false });
    await expect(failureStatus()).resolves.toBe("VERIFIED");
  });

  it("leaves the failure to its newest attempt", async () => {
    const { system, failure, attempt, failureStatus } = await opened();
    await system.attempts.create({
      failureId: failure.id,
      targetSha: failure.headSha,
      failingCheck: "test",
    });

    await expect(
      system.attempts.recordVerification(attempt.id, { result: "verified" }),
    ).resolves.toEqual({ changed: true });
    await expect(failureStatus()).resolves.toBe("PR_OPENED");
  });

  it("changes nothing for an attempt without a pull request, and refuses unknown results", async () => {
    const { system, attempt } = await opened();
    await db.healAttempt.update({ where: { id: attempt.id }, data: { status: "RUNNING" } });

    await expect(
      system.attempts.recordVerification(attempt.id, { result: "verified" }),
    ).resolves.toEqual({ changed: false });
    await expect(
      system.attempts.recordVerification(attempt.id, { result: "merged" as "verified" }),
    ).rejects.toThrow();
  });
});
