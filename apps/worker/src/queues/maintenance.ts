import { Queue, UnrecoverableError, Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "@pipeheal/shared/logger";
import { z } from "zod";

// The `maintenance` queue (SPEC §4): the periodic reconciler (SPEC §2.2, ./reconcile.ts), and a
// `ping` job that proves the queue round-trip works.
export const MAINTENANCE_QUEUE = "maintenance";

/** How often the reconciler sweeps. */
export const RECONCILE_EVERY_MS = 5 * 60_000;

const PingData = z.object({ requestedAt: z.iso.datetime() });
export type PingData = z.infer<typeof PingData>;

export interface PingResult {
  pong: true;
  requestedAt: string;
}

interface MaintenanceJob {
  id?: string | undefined;
  name: string;
  data: unknown;
}

export function processMaintenanceJob(job: MaintenanceJob, logger: Logger): PingResult {
  switch (job.name) {
    case "ping": {
      const data = PingData.parse(job.data);
      logger.info({ jobId: job.id }, "maintenance ping processed");
      return { pong: true, requestedAt: data.requestedAt };
    }
    default:
      // Retrying cannot help with a job type we don't know.
      throw new UnrecoverableError(`unknown maintenance job "${job.name}"`);
  }
}

export type MaintenanceQueue = Queue<unknown, unknown, "ping" | "reconcile">;

/** Schedules the sweep. Idempotent: restarting the worker replaces the same schedule. */
export async function scheduleReconciler(queue: MaintenanceQueue): Promise<void> {
  await queue.upsertJobScheduler(
    "reconcile",
    { every: RECONCILE_EVERY_MS },
    // The next sweep is the retry.
    { name: "reconcile", data: {}, opts: { attempts: 1, removeOnComplete: 10 } },
  );
}

// `prefix` isolates keys (tests use a unique one); production uses BullMQ's default.
export function createMaintenanceQueue(
  connection: Redis,
  logger: Logger,
  prefix?: string,
): MaintenanceQueue {
  const queue: MaintenanceQueue = new Queue(MAINTENANCE_QUEUE, {
    connection,
    prefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });
  // Without a listener BullMQ prints connection errors (with stack) straight to stderr.
  queue.on("error", (error) => {
    logger.error({ error: error.message }, "maintenance queue error");
  });
  return queue;
}

export function createMaintenanceWorker(
  connection: Redis,
  logger: Logger,
  prefix?: string,
  /** The reconciler's sweep; without it a `reconcile` job is unknown. */
  reconcile?: () => Promise<void>,
): Worker {
  const worker = new Worker(
    MAINTENANCE_QUEUE,
    // One at a time, so sweeps never overlap in a process.
    async (job) =>
      job.name === "reconcile" && reconcile !== undefined
        ? reconcile()
        : processMaintenanceJob(job, logger),
    { connection, prefix, concurrency: 1 },
  );
  worker.on("failed", (job, error) => {
    logger.error(
      { jobId: job?.id, job: job?.name, error: error.message },
      "maintenance job failed",
    );
  });
  worker.on("error", (error) => {
    logger.error({ error: error.message }, "maintenance worker error");
  });
  return worker;
}
