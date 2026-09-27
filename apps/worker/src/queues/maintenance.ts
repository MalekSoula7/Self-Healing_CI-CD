import { Queue, UnrecoverableError, Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { z } from "zod";

// The `maintenance` queue (SPEC §4) will host the reconciler and timeout sweeps (SPEC §2.2).
// For now it carries a `ping` job that proves the queue round-trip works.
export const MAINTENANCE_QUEUE = "maintenance";

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

export type MaintenanceQueue = Queue<PingData, PingResult, "ping">;

// `prefix` isolates keys (tests use a unique one); production uses BullMQ's default.
export function createMaintenanceQueue(
  connection: Redis,
  logger: Logger,
  prefix?: string,
): MaintenanceQueue {
  const queue = new Queue<PingData, PingResult, "ping">(MAINTENANCE_QUEUE, {
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
): Worker {
  const worker = new Worker(
    MAINTENANCE_QUEUE,
    (job) => Promise.resolve(processMaintenanceJob(job, logger)),
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
