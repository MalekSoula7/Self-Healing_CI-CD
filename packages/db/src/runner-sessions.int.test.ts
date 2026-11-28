// Needs Postgres: `docker compose up -d`. Runner sessions (SPEC §5.4): an attempt is found only
// through the IDs GitHub signed, and it gets exactly one session, opened in time.
import { randomInt, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { installations } from "./installations";
import { DISPATCH_TIMEOUT_MS, SESSION_TTL_MS, runnerSessions } from "./runner-sessions";
import { forSystem } from "./scope";
import { createTestDb } from "./testing";

const db = createTestDb();
const sessions = runnerSessions(db, "test");

const githubId = () => BigInt(randomInt(1, 2 ** 47));
const sha = () => randomUUID().replaceAll("-", "").padEnd(40, "0");
const hash = (char: string) => char.repeat(64);

/** An org with one repository, one failure and one dispatched attempt on it. */
async function dispatched() {
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
    headSha: sha(),
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
    dispatchRunId: 777n,
  });
  const ref = {
    attemptId: attempt.id,
    githubRepoId: repo.githubRepoId,
    githubOwnerId: org.githubAccountId,
  };
  return { org, repo, failure, attempt, ref, system };
}

describe("runnerSessions.find", () => {
  it("returns the attempt with its repository and org status for the signed IDs", async () => {
    const { attempt, repo, ref } = await dispatched();

    const found = await sessions.find(ref);

    expect(found).toMatchObject({
      id: attempt.id,
      status: "DISPATCHED",
      failingCheck: "test",
      dispatchRunId: 777n,
      sessionTokenHash: null,
      org: { status: "ACTIVE" },
      failure: { repo: { id: repo.id, defaultBranch: "main", enabled: true } },
    });
  });

  it("finds nothing for malformed IDs or another repository", async () => {
    const { ref } = await dispatched();

    await expect(sessions.find({ ...ref, attemptId: "not-a-uuid" })).resolves.toBeNull();
    await expect(sessions.find({ ...ref, attemptId: randomUUID() })).resolves.toBeNull();
    await expect(sessions.find({ ...ref, githubRepoId: githubId() })).resolves.toBeNull();
    await expect(sessions.find({ ...ref, githubRepoId: 0n })).resolves.toBeNull();
  });
});

describe("runnerSessions.open", () => {
  it("opens one session, stores only its hash, and refuses a second", async () => {
    const { ref } = await dispatched();
    const now = new Date();

    const opened = await sessions.open(ref, { tokenHash: hash("1"), now });
    const again = await sessions.open(ref, { tokenHash: hash("2"), now });

    expect(opened?.expiresAt.getTime()).toBe(now.getTime() + SESSION_TTL_MS);
    expect(again).toBeNull();
    await expect(sessions.find(ref)).resolves.toMatchObject({
      status: "RUNNING",
      sessionTokenHash: hash("1"),
    });
  });

  it("lets exactly one of several simultaneous exchanges win", async () => {
    const { ref } = await dispatched();
    const now = new Date();

    const results = await Promise.all(
      ["3", "4", "5", "6"].map((char) => sessions.open(ref, { tokenHash: hash(char), now })),
    );

    expect(results.filter((result) => result !== null)).toHaveLength(1);
  });

  it("refuses once the dispatch timeout has passed", async () => {
    const { attempt, ref } = await dispatched();
    const late = new Date(attempt.dispatchedAt.getTime() + DISPATCH_TIMEOUT_MS + 1_000);

    await expect(sessions.open(ref, { tokenHash: hash("7"), now: late })).resolves.toBeNull();
    await expect(sessions.find(ref)).resolves.toMatchObject({ status: "DISPATCHED" });
  });

  it("refuses an attempt that isn't DISPATCHED, and another repository's IDs", async () => {
    const { attempt, ref } = await dispatched();
    // A status only later tasks set through their own helpers; written directly as setup.
    await db.healAttempt.update({ where: { id: attempt.id }, data: { status: "FAILED" } });
    const other = await dispatched();

    await expect(sessions.open(ref, { tokenHash: hash("8"), now: new Date() })).resolves.toBeNull();
    await expect(
      sessions.open(
        { ...other.ref, githubRepoId: ref.githubRepoId },
        { tokenHash: hash("9"), now: new Date() },
      ),
    ).resolves.toBeNull();
    await expect(sessions.find(other.ref)).resolves.toMatchObject({ status: "DISPATCHED" });
  });

  it("refuses an attempt whose dispatch run isn't recorded (D16), then opens once it is", async () => {
    const { failure, ref, system } = await dispatched();
    const unrecorded = await system.attempts.create({
      failureId: failure.id,
      targetSha: failure.headSha,
      failingCheck: "test",
    });
    const unrecordedRef = { ...ref, attemptId: unrecorded.id };

    await expect(
      sessions.open(unrecordedRef, { tokenHash: hash("a"), now: new Date() }),
    ).resolves.toBeNull();
    await system.attempts.recordDispatch(unrecorded.id, 888n);
    await expect(
      sessions.open(unrecordedRef, { tokenHash: hash("b"), now: new Date() }),
    ).resolves.not.toBeNull();
  });

  it("ends the session with the attempt's budget when that comes first", async () => {
    const { ref } = await dispatched();
    const now = new Date();

    const opened = await sessions.open(ref, { tokenHash: hash("c"), now, ttlMs: 25 * 60_000 });

    expect(opened?.expiresAt.getTime()).toBe(now.getTime() + 25 * 60_000);
    await expect(
      sessions.open(ref, { tokenHash: hash("d"), now, ttlMs: SESSION_TTL_MS + 1 }),
    ).rejects.toThrow();
  });

  it("re-checks the org and repository inside the claim", async () => {
    const suspended = await dispatched();
    await installations(db, "test").setStatus(suspended.org.installationId, "SUSPENDED");
    const disabled = await dispatched();
    await disabled.system.repositories.setEnabled(disabled.repo.id, false);

    for (const { ref } of [suspended, disabled]) {
      await expect(
        sessions.open(ref, { tokenHash: hash("e"), now: new Date() }),
      ).resolves.toBeNull();
    }
  });

  it("refuses a malformed token hash", async () => {
    const { ref } = await dispatched();

    await expect(sessions.open(ref, { tokenHash: "short", now: new Date() })).rejects.toThrow();
  });
});

describe("attempts.create", () => {
  it("numbers attempts per failure", async () => {
    const { failure, system } = await dispatched();

    const second = await system.attempts.create({
      failureId: failure.id,
      targetSha: failure.headSha,
      failingCheck: "lint",
    });

    expect(second).toMatchObject({ attemptNo: 2, status: "DISPATCHED", dispatchRunId: null });
  });
});

describe("runnerSessions.contest", () => {
  it("fails a running attempt and revokes its session", async () => {
    const { ref } = await dispatched();
    const now = new Date();
    await sessions.open(ref, { tokenHash: hash("f"), now });

    await expect(sessions.contest(ref, { now, reason: "second exchange" })).resolves.toBe(true);
    await expect(sessions.find(ref)).resolves.toMatchObject({
      status: "FAILED",
      sessionTokenHash: null,
    });
    // Once failed, it stays failed: nothing reopens it.
    await expect(sessions.contest(ref, { now, reason: "again" })).resolves.toBe(false);
    await expect(sessions.open(ref, { tokenHash: hash("0"), now })).resolves.toBeNull();
  });

  it("leaves an attempt without a session, or another repository's, alone", async () => {
    const { ref } = await dispatched();
    const other = await dispatched();

    await expect(sessions.contest(ref, { now: new Date(), reason: "x" })).resolves.toBe(false);
    await expect(
      sessions.contest(
        { ...ref, githubRepoId: other.ref.githubRepoId },
        { now: new Date(), reason: "x" },
      ),
    ).resolves.toBe(false);
    await expect(sessions.find(ref)).resolves.toMatchObject({ status: "DISPATCHED" });
  });
});

describe("attempts.recordDispatch", () => {
  it("records the run once, accepts the same run again, refuses another", async () => {
    const { failure, system } = await dispatched();
    const attempt = await system.attempts.create({
      failureId: failure.id,
      targetSha: failure.headSha,
      failingCheck: "test",
    });

    await expect(system.attempts.recordDispatch(attempt.id, 900n)).resolves.toMatchObject({
      dispatchRunId: 900n,
    });
    await expect(system.attempts.recordDispatch(attempt.id, 900n)).resolves.toMatchObject({
      dispatchRunId: 900n,
    });
    await expect(system.attempts.recordDispatch(attempt.id, 901n)).rejects.toThrow(
      "already recorded",
    );
    await expect(system.attempts.recordDispatch(attempt.id, 0n)).rejects.toThrow();
  });
});
