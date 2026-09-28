// The `failures` queue: timed steps of a failure's life. For now, closing the collection window
// when its time is up (SPEC §2.1); triage (P2.2+) starts from here once the window has closed.
import { NotFoundError, forSystem, type Db } from "@pipeheal/db";
import type { Logger } from "@pipeheal/shared/logger";
import { Queue, UnrecoverableError, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { z } from "zod";

export const FAILURES_QUEUE = "failures";

const closeWindowDataSchema = z.strictObject({ orgId: z.uuid(), failureId: z.uuid() });
export type CloseWindowData = z.infer<typeof closeWindowDataSchema>;

export type FailuresQueue = Queue<CloseWindowData, void, "close-window">;

/** Schedules closing a failure's window at `at`. Idempotent: one job per failure. */
export type ScheduleWindowClose = (orgId: string, failureId: string, at: Date) => Promise<void>;

interface QueueJob {
  id?: string | undefined;
  name: string;
  data: unknown;
}

export async function processFailuresJob(
  job: QueueJob,
  deps: { db: Db; logger: Logger },
): Promise<void> {
  if (job.name !== "close-window") {
    throw new UnrecoverableError(`unknown failures job "${job.name}"`);
  }
  const { orgId, failureId } = closeWindowDataSchema.parse(job.data);
  const log = deps.logger.child({ jobId: job.id, failureId });
  try {
    const system = await forSystem(deps.db, orgId, "collection-window");
    const failure = await system.failures.closeWindow(failureId);
    log.info({ closedAt: failure.windowClosedAt }, "collection window closed");
  } catch (error) {
    // The organization or failure is gone (uninstalled, deleted): nothing left to close.
    if (!(error instanceof NotFoundError)) throw error;
    log.info("collection window: failure no longer exists");
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

export function scheduleWindowClose(queue: FailuresQueue): ScheduleWindowClose {
  return async (orgId, failureId, at) => {
    await queue.add(
      "close-window",
      { orgId, failureId },
      // Custom job IDs can't contain ":" in BullMQ.
      { jobId: `close-window-${failureId}`, delay: Math.max(0, at.getTime() - Date.now()) },
    );
  };
}

export function createFailuresWorker(
  connection: Redis,
  deps: { db: Db; logger: Logger },
  prefix?: string,
): Worker {
  const worker = new Worker(FAILURES_QUEUE, (job: QueueJob) => processFailuresJob(job, deps), {
    connection,
    prefix,
    concurrency: 5,
  });
  worker.on("failed", (job, error) => {
    deps.logger.error({ jobId: job?.id, error: error.message }, "failures job failed");
  });
  worker.on("error", (error) => {
    deps.logger.error({ error: error.message }, "failures worker error");
  });
  return worker;
}
