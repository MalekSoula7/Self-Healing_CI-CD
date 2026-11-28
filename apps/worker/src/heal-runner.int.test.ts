// Needs Postgres: `docker compose up -d`. What the healer's turn reads from the database
// (SPEC §7.1): the brief and the effective policy, only for an attempt with an open session.
import { randomInt, randomUUID } from "node:crypto";
import { forSystem, installations, runnerSessions } from "@pipeheal/db";
import { createTestDb } from "@pipeheal/db/testing";
import { describe, expect, it } from "vitest";
import { loadHealInputs } from "./heal-runner";

const db = createTestDb();
const githubId = () => BigInt(randomInt(1, 2 ** 47));

async function attempt(options: { open: boolean }) {
  const login = `T${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const org = await installations(db, "test").upsert({
    githubAccountId: githubId(),
    login,
    accountType: "ORG",
    installationId: githubId(),
  });
  const system = await forSystem(db, org.id, "test");
  const [repo] = await system.repositories.syncInstalled([
    { githubRepoId: githubId(), fullName: `${login}/shop`, defaultBranch: "main" },
  ]);
  if (repo === undefined) throw new Error("test setup: no repository");
  await system.repositories.setEnabled(repo.id, true);
  // Written directly as setup: commands come from onboarding (not built yet).
  await db.repository.update({
    where: { id: repo.id },
    data: { commands: { test: ["pnpm", "test"] }, language: "TypeScript" },
  });
  await system.policies.save("REPO", repo.id, { limits: { maxWallClockMinutes: 15 } });
  const runId = githubId();
  const { failure } = await system.failures.recordFailedRun(repo.id, {
    headSha: randomUUID().replaceAll("-", "").padEnd(40, "0"),
    headBranch: "feat/cart",
    runId,
    runAttempt: 1,
    workflowId: 11n,
    workflowName: "CI",
    workflowPath: ".github/workflows/ci.yml",
    conclusion: "failure",
    htmlUrl: `https://github.com/acme/shop/actions/runs/${String(runId)}`,
    jobs: [{ githubJobId: githubId(), name: "test", failedStep: "Run tests", htmlUrl: null }],
  });
  const created = await system.attempts.create({
    failureId: failure.id,
    targetSha: failure.headSha,
    failingCheck: "test",
    dispatchRunId: githubId(),
  });
  if (options.open) {
    await runnerSessions(db, "test").open(
      {
        attemptId: created.id,
        githubRepoId: repo.githubRepoId,
        githubOwnerId: org.githubAccountId,
      },
      { tokenHash: randomUUID().replaceAll("-", "").repeat(2), now: new Date() },
    );
  }
  return { orgId: org.id, attemptId: created.id, fullName: repo.fullName };
}

describe("loadHealInputs", () => {
  it("briefs the turn with the attempt's repository, failure, jobs and policy", async () => {
    const { orgId, attemptId, fullName } = await attempt({ open: true });

    const inputs = await loadHealInputs(db, orgId, attemptId);

    expect(inputs?.brief).toEqual({
      repo: { fullName, defaultBranch: "main", language: "TypeScript" },
      commands: { test: ["pnpm", "test"] },
      failingCheck: "test",
      failure: { category: null, summary: null, headBranch: "feat/cart" },
      // A job not triaged yet has no evidence to show (P4.4 review L6).
      jobs: [],
      recentChanges: null,
    });
    expect(inputs?.policy.limits.maxWallClockMinutes).toBe(15);
    expect(inputs?.startedAt).toBeInstanceOf(Date);
  });

  it("has nothing for an attempt without a session, or another org's", async () => {
    const closed = await attempt({ open: false });
    const other = await attempt({ open: true });

    await expect(loadHealInputs(db, closed.orgId, closed.attemptId)).resolves.toBeNull();
    await expect(loadHealInputs(db, closed.orgId, other.attemptId)).resolves.toBeNull();
  });
});

describe("loadHealInputs for a retry (P5.3d)", () => {
  it("briefs with what CI said about the earlier fix, not the original logs", async () => {
    const { orgId, attemptId } = await attempt({ open: true });
    const feedback = [{ name: "lint", failedStep: "Lint", summary: "unused", errorWindow: "boom" }];
    await db.healAttempt.update({
      where: { id: attemptId },
      data: { retryOfId: attemptId, feedback },
    });

    const inputs = await loadHealInputs(db, orgId, attemptId);

    expect(inputs?.brief).toMatchObject({ previousFix: true, jobs: feedback });
  });
});
