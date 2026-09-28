// Needs Postgres and Redis: `docker compose up -d`. Real BullMQ, on a unique key prefix per run.
import { randomInt, randomUUID } from "node:crypto";
import { forSystem, installations } from "@pipeheal/db";
import { createTestDb } from "@pipeheal/db/testing";
import { createLogger } from "@pipeheal/shared/logger";
import { testRedisUrl } from "@pipeheal/shared/testing";
import { UnrecoverableError } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createFailuresQueue,
  processFailuresJob,
  scheduleWindowClose,
  type FailuresQueue,
} from "./failures";

const db = createTestDb();
const logger = createLogger({ level: "silent", service: "test" });
const prefix = `test-${randomUUID()}`;
let connection: Redis;
let queue: FailuresQueue;

beforeAll(() => {
  connection = new Redis(testRedisUrl(), { maxRetriesPerRequest: null });
  queue = createFailuresQueue(connection, logger, prefix);
});

afterAll(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
  connection.disconnect();
  await db.$disconnect();
});

function githubId(): bigint {
  return BigInt(randomInt(1, 2 ** 47));
}

/** An org with a repo and an open failure. */
async function openFailure() {
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
  const { failure } = await system.failures.recordFailedRun(repo.id, {
    headSha: "a".repeat(40),
    headBranch: "main",
    runId: githubId(),
    runAttempt: 1,
    workflowId: 1n,
    workflowName: "CI",
    workflowPath: ".github/workflows/ci.yml",
    conclusion: "failure",
    htmlUrl: null,
    jobs: [],
  });
  return { orgId: org.id, failure };
}

describe("close-window job", () => {
  it("closes the failure's collection window", async () => {
    const { orgId, failure } = await openFailure();

    await processFailuresJob(
      { name: "close-window", data: { orgId, failureId: failure.id } },
      { db, logger },
    );

    const closed = await db.pipelineFailure.findUniqueOrThrow({ where: { id: failure.id } });
    expect(closed.windowClosedAt).toBeInstanceOf(Date);
    await expect(
      db.auditLog.count({ where: { orgId, action: "failure.window_closed" } }),
    ).resolves.toBe(1);
  });

  it("does nothing when the failure (or its organization) is gone", async () => {
    const { orgId } = await openFailure();

    for (const data of [
      { orgId, failureId: randomUUID() },
      { orgId: randomUUID(), failureId: randomUUID() },
    ]) {
      await expect(
        processFailuresJob({ name: "close-window", data }, { db, logger }),
      ).resolves.toBeUndefined();
    }
  });

  it("refuses unknown jobs and malformed data without retrying", async () => {
    await expect(processFailuresJob({ name: "triage", data: {} }, { db, logger })).rejects.toThrow(
      UnrecoverableError,
    );
    await expect(
      processFailuresJob({ name: "close-window", data: { orgId: "x" } }, { db, logger }),
    ).rejects.toThrow();
  });
});

describe("scheduleWindowClose", () => {
  it("queues one delayed job per failure, however often it's asked", async () => {
    const failureId = randomUUID();
    const orgId = randomUUID();
    const at = new Date(Date.now() + 5 * 60_000);
    const schedule = scheduleWindowClose(queue);

    await schedule(orgId, failureId, at);
    await schedule(orgId, failureId, at);

    const job = await queue.getJob(`close-window-${failureId}`);
    expect(await job?.getState()).toBe("delayed");
    expect(job?.data).toEqual({ orgId, failureId });
    expect(job?.opts.delay).toBeGreaterThan(4 * 60_000);
    const delayed = await queue.getDelayed();
    expect(delayed.filter((j) => j.data.failureId === failureId)).toHaveLength(1);
  });

  it("closes right away when the time is already past", async () => {
    const failureId = randomUUID();

    await scheduleWindowClose(queue)(randomUUID(), failureId, new Date(Date.now() - 1000));

    const job = await queue.getJob(`close-window-${failureId}`);
    expect(job?.opts.delay).toBe(0);
    expect(await job?.getState()).toBe("waiting");
  });
});
