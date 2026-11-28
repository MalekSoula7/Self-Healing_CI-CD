// The `submissions` queue (SPEC §4, P5.1-P5.2): one `validate` job per attempt checks the runner's
// submission on the server (the diff rebuilt from the target commit, static + behavioral + judge),
// then a passing one queues `publish`, which opens the pull request. The gateway queues `validate`
// once the upload is stored; job IDs make repeats no-ops.
import type { Logger } from "@pipeheal/shared/logger";
import { Queue, UnrecoverableError, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { z } from "zod";
import { publishAttempt, recordUnpublishable, type PublishDeps } from "./publish";
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

export interface SubmissionsDeps extends ValidateDeps, PublishDeps {
  logger: Logger;
}

/** Queues an attempt's pull request once its submission passed. The job ID makes it once. */
export async function enqueuePublish(queue: SubmissionsQueue, job: ValidationJob): Promise<void> {
  const data = validationJobSchema.parse(job);
  await queue.add("publish", data, {
    jobId: `publish-${data.attemptId}`,
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: 1_000,
    removeOnFail: 1_000,
  });
}

const PENDING_STATES = new Set(["waiting", "active", "delayed", "prioritized", "waiting-children"]);

/** Where an attempt's job stands: still to run (or running), finished, or lost. */
export async function submissionJobState(
  queue: SubmissionsQueue,
  name: "validate" | "publish",
  attemptId: string,
): Promise<"pending" | "finished" | "none"> {
  const job = await queue.getJob(`${name}-${attemptId}`);
  if (job === undefined) return "none";
  return PENDING_STATES.has(await job.getState()) ? "pending" : "finished";
}

/** Queues a fresh job, replacing a finished one (its ID would make the new one a no-op). */
export async function requeueSubmission(
  queue: SubmissionsQueue,
  name: "validate" | "publish",
  job: ValidationJob,
): Promise<void> {
  const finished = await queue.getJob(`${name}-${job.attemptId}`);
  await finished?.remove();
  await (name === "validate" ? enqueueValidation : enqueuePublish)(queue, job);
}

export async function processValidationJob(
  job: { id?: string | undefined; name: string; data: unknown },
  deps: SubmissionsDeps,
): Promise<void> {
  if (job.name !== "validate" && job.name !== "publish") {
    throw new UnrecoverableError(`unknown submissions job "${job.name}"`);
  }
  const data = validationJobSchema.parse(job.data);
  const log = deps.logger.child({ attemptId: data.attemptId });
  if (job.name === "publish") await publishAttempt(deps, data, log);
  else await validateSubmission(deps, data, log);
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
    const data = validationJobSchema.safeParse(job.data);
    if (!data.success) return;
    // Retries spent: the attempt ends rather than wait VALIDATING or VALIDATED forever.
    const end = job.name === "publish" ? recordUnpublishable : recordUncheckable;
    end(deps.db, data.data).catch((failure: unknown) => {
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
