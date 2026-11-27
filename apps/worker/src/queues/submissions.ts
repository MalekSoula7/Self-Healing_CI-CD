// The `submissions` queue (SPEC §4, P5.1): one `validate` job per attempt checks the runner's
// submission on the server (the diff rebuilt from the target commit, static + behavioral + judge).
// The gateway queues it once the upload is stored; the job ID makes a repeat a no-op.
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { z } from "zod";

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
