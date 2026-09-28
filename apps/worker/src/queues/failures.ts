// The `failures` queue: the timed and GitHub-heavy steps of a failure's life (SPEC §2.1, §6.2).
// `close-window` closes the collection window when its time is up, then queues `triage`, which
// fetches, cleans and redacts the failed jobs' logs. Triage calls GitHub, so its jobs are paced
// per installation like webhook jobs.
import { NotFoundError, forSystem, type Db } from "@pipeheal/db";
import type { GitHubApp } from "@pipeheal/github";
import type { Logger } from "@pipeheal/shared/logger";
import { Queue, UnrecoverableError, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { z } from "zod";
import {
  assertNotPaused,
  delayWhenRateLimited,
  pauseIfRateLimited,
  type InstallationPacing,
} from "../pacing";
import { triageFailure, type FailureTarget } from "./triage";

export const FAILURES_QUEUE = "failures";

// Job data is JSON: the installation ID travels as a string.
const targetSchema = z
  .strictObject({ orgId: z.uuid(), failureId: z.uuid(), installationId: z.string().regex(/^\d+$/) })
  .transform(({ installationId, ...ids }) => ({ ...ids, installationId: BigInt(installationId) }));
type FailureJobData = z.input<typeof targetSchema>;
type FailureJobName = "close-window" | "triage";

export type FailuresQueue = Queue<FailureJobData, void, FailureJobName>;

/** How the webhook processor and the queue itself schedule a failure's next steps. */
export interface FailureJobs {
  /** Closes the window at `at`. Idempotent: one job per failure. */
  scheduleWindowClose: (target: FailureTarget, at: Date) => Promise<void>;
  /**
   * Triages the failure's jobs not triaged yet. Idempotent per `key`: the window closing uses
   * none; a run attached after that (a late arrival, or a newer failed attempt) passes its own.
   */
  enqueueTriage: (target: FailureTarget, key?: string) => Promise<void>;
}

export interface FailuresDeps {
  db: Db;
  githubApp: GitHubApp | null;
  logger: Logger;
  pacing: InstallationPacing;
  jobs: FailureJobs;
}

interface QueueJob {
  id?: string | undefined;
  name: string;
  data: unknown;
}

export async function processFailuresJob(job: QueueJob, deps: FailuresDeps): Promise<void> {
  if (job.name !== "close-window" && job.name !== "triage") {
    throw new UnrecoverableError(`unknown failures job "${job.name}"`);
  }
  const target = targetSchema.parse(job.data);
  const log = deps.logger.child({ jobId: job.id, failureId: target.failureId });
  try {
    if (job.name === "close-window") {
      const system = await forSystem(deps.db, target.orgId, "collection-window");
      const failure = await system.failures.closeWindow(target.failureId);
      log.info({ closedAt: failure.windowClosedAt }, "collection window closed");
      await deps.jobs.enqueueTriage(target);
      return;
    }
    await assertNotPaused(deps.pacing, target.installationId);
    try {
      await triageFailure(deps, target, log);
    } catch (error) {
      await pauseIfRateLimited(deps.pacing, target.installationId, error);
      throw error;
    }
  } catch (error) {
    // The organization or failure is gone (uninstalled, deleted): nothing left to do.
    if (!(error instanceof NotFoundError)) throw error;
    log.info("failure no longer exists");
  }
}

export function createFailuresQueue(
  connection: Redis,
  logger: Logger,
  prefix?: string,
): FailuresQueue {
  const queue: FailuresQueue = new Queue(FAILURES_QUEUE, {
    connection,
    prefix,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });
  queue.on("error", (error) => {
    logger.error({ error: error.message }, "failures queue error");
  });
  return queue;
}

function jobData(target: FailureTarget): FailureJobData {
  return { ...target, installationId: String(target.installationId) };
}

// Custom job IDs can't contain ":" in BullMQ.
export function failureJobs(queue: FailuresQueue): FailureJobs {
  return {
    async scheduleWindowClose(target, at) {
      await queue.add("close-window", jobData(target), {
        jobId: `close-window-${target.failureId}`,
        delay: Math.max(0, at.getTime() - Date.now()),
      });
    },
    async enqueueTriage(target, key) {
      await queue.add("triage", jobData(target), {
        jobId: `triage-${target.failureId}${key === undefined ? "" : `-${key}`}`,
      });
    },
  };
}

export function createFailuresWorker(
  connection: Redis,
  deps: FailuresDeps,
  prefix?: string,
): Worker {
  const worker = new Worker(
    FAILURES_QUEUE,
    delayWhenRateLimited((job: Job) => processFailuresJob(job, deps)),
    { connection, prefix, concurrency: 5 },
  );
  worker.on("failed", (job, error) => {
    deps.logger.error({ jobId: job?.id, error: error.message }, "failures job failed");
  });
  worker.on("error", (error) => {
    deps.logger.error({ error: error.message }, "failures worker error");
  });
  return worker;
}
