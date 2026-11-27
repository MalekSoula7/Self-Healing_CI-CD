// Needs Postgres: `docker compose up -d`. Local mode's attempt (P4.6): real rows through the
// production helpers, and a session the gateway authenticates like any runner's.
import { randomUUID } from "node:crypto";
import { forSystem, runnerSessions } from "@pipeheal/db";
import { createTestDb } from "@pipeheal/db/testing";
import { describe, expect, it } from "vitest";
import { hashSessionToken } from "./gateway/session";
import { LOCAL_ORG, createLocalAttempt, localRepoId } from "./local-attempt";

const db = createTestDb();
const sha = () => randomUUID().replaceAll("-", "").padEnd(40, "0");
const input = (targetSha: string) => ({
  repoName: `demo-${randomUUID().slice(0, 8)}`,
  targetSha,
  failingCheck: "test" as const,
  commands: { install: ["npm", "ci"], test: ["npm", "run", "test:ci"] },
  junitGlob: "reports/junit.xml",
});

describe("createLocalAttempt", () => {
  it("opens a real session the gateway authenticates, for a RUNNING attempt", async () => {
    const targetSha = sha();
    const local = await createLocalAttempt(db, input(targetSha));

    const session = await runnerSessions(db, "test").authenticate(
      hashSessionToken(local.sessionToken),
      new Date(),
    );

    expect(session).toMatchObject({ attemptId: local.attemptId, status: "RUNNING" });
    expect(local.session.attempt).toMatchObject({
      targetSha,
      failingCheck: "test",
      junitGlob: "reports/junit.xml",
      commands: { test: ["npm", "run", "test:ci"] },
    });
    const stored = await db.healAttempt.findUniqueOrThrow({ where: { id: local.attemptId } });
    expect(stored.sessionTokenHash).not.toBe(local.sessionToken);
  });

  it("reuses the local org and repository on a second run", async () => {
    const first = input(sha());
    const a = await createLocalAttempt(db, first);
    const b = await createLocalAttempt(db, { ...first, targetSha: sha() });

    expect(b.orgId).toBe(a.orgId);
    const system = await forSystem(db, a.orgId, "test");
    const repo = await system.repositories.findByGithubId(localRepoId(first.repoName));
    expect(repo).toMatchObject({
      enabled: true,
      fullName: `${LOCAL_ORG.login}/${first.repoName}`,
      commands: first.commands,
    });
  });

  it("gives each demo name a stable fake GitHub ID", () => {
    expect(localRepoId("demo-node")).toBe(localRepoId("demo-node"));
    expect(localRepoId("demo-node")).not.toBe(localRepoId("demo-python"));
  });
});
