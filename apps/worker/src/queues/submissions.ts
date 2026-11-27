// The `submissions` queue (SPEC §4, P5.1): one `validate` job per attempt checks the runner's
// submission on the server (the diff rebuilt from the target commit, static + behavioral + judge).
// The gateway queues it once the upload is stored; the job ID makes a repeat a no-op.
import type { Logger } from "@pipeheal/shared/logger";
import { Queue, UnrecoverableError, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { z } from "zod";
import { recordUncheckable, validateSubmission, type ValidateDeps } from "./validate";

export const SUBMISSIONS_QUEUE = "submissions";

export const validationJobSchema = z.strictObject({ orgId: z.uuid(), attemptId: z.uuid() });
export type ValidationJob = z.infer<typeof validationJobSchema>;

// `prefix` isolates keys (tests use a unique one); production uses BullMQ's default.
export function createSubmissionsQueue(connection: Redis, prefix?: string) {
  return new Queue(SUBMISSIONS_QUEUE, { connection, ...(prefix === undefined ? {} : { prefix }) });
}

export type SubmissionsQueue = ReturnType<typeof createSubmissionsQueue>;

/**
 * Queues an attempt's validation. A job that failed for good (its retries spent) is retried, so a
 * re-sent upload can unstick it.
 */
export async function enqueueValidation(
  queue: SubmissionsQueue,
  job: ValidationJob,
): Promise<void> {
  const data = validationJobSchema.parse(job);
  const jobId = `validate-${data.attemptId}`;
  const existing = await queue.getJob(jobId);
  if (existing !== undefined && (await existing.isFailed())) {
    await existing.retry();
    return;
  }
  await queue.add("validate", data, {
    jobId,
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: 1_000,
    removeOnFail: 1_000,
  });
}

export interface SubmissionsDeps extends ValidateDeps {
  logger: Logger;
}

export async function processValidationJob(
  job: { id?: string | undefined; name: string; data: unknown },
  deps: SubmissionsDeps,
): Promise<void> {
  if (job.name !== "validate") {
    throw new UnrecoverableError(`unknown submissions job "${job.name}"`);
  }
  const data = validationJobSchema.parse(job.data);
  await validateSubmission(deps, data, deps.logger.child({ attemptId: data.attemptId }));
}

export function createSubmissionsWorker(connection: Redis, deps: SubmissionsDeps, prefix?: string) {
  // One at a time: the judge's model calls share the GPU (D11).
  const worker = new Worker(SUBMISSIONS_QUEUE, (job) => processValidationJob(job, deps), {
    connection,
    concurrency: 1,
    ...(prefix === undefined ? {} : { prefix }),
  });
  worker.on("failed", (job, error) => {
    // The error's class only: GitHub errors can name repository paths (review L7).
    deps.logger.error({ jobId: job?.id, error: error.name }, "submissions job failed");
    if (job === undefined || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    // Retries spent: the attempt ends REJECTED instead of staying VALIDATING (review M1).
    const data = validationJobSchema.safeParse(job.data);
    if (!data.success) return;
    recordUncheckable(deps.db, data.data).catch((failure: unknown) => {
      deps.logger.error(
        { jobId: job.id, error: failure instanceof Error ? failure.name : "unknown" },
        "couldn't record an unchecked submission",
      );
    });
  });
  worker.on("error", (error) => {
    deps.logger.error({ error: error.message }, "submissions worker error");
  });
  return worker;
}
