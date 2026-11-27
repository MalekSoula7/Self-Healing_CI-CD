// The `failures` queue: the timed and GitHub-heavy steps of a failure's life (SPEC §2.1, §6.2).
// `close-window` closes the collection window when its time is up, then queues `triage`, which
// fetches, cleans and redacts the failed jobs' logs and classifies them, then queues
// `recent-changes` (what changed since the last green commit) and `flaky-check` (re-run the failed
// jobs once), which queues `dispatch` (create the attempt and dispatch the healer, P4.8). Closing
// the window also queues `policy-file` (re-read `.pipeheal.yml`, P3.7). All of these but
// `close-window` call GitHub, so their jobs are paced per installation like webhook jobs.
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
import { dispatchFailure, type DispatchDeps } from "./dispatch";
import { checkFlaky, type FlakyCheckDeps } from "./flaky-check";
import { refreshFailurePolicyFile } from "./policy-file";
import { resolveRecentChanges } from "./recent-changes";
import { triageFailure, type FailureTarget, type TriageDeps } from "./triage";

export const FAILURES_QUEUE = "failures";

// Job data is JSON: the installation ID travels as a string.
const targetSchema = z
  .strictObject({ orgId: z.uuid(), failureId: z.uuid(), installationId: z.string().regex(/^\d+$/) })
  .transform(({ installationId, ...ids }) => ({ ...ids, installationId: BigInt(installationId) }));
type FailureJobData = z.input<typeof targetSchema>;
type FailureJobName =
  "close-window" | "triage" | "recent-changes" | "flaky-check" | "policy-file" | "dispatch";
const JOB_NAMES = new Set<string>([
  "close-window",
  "triage",
  "recent-changes",
  "flaky-check",
  "policy-file",
  "dispatch",
]);

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
  /** Resolves what changed since the last green commit. Idempotent: one job per failure. */
  enqueueRecentChanges: (target: FailureTarget) => Promise<void>;
  /**
   * Re-runs failed jobs once to tell flaky from real (SPEC §6.2 step 8). Idempotent per `key`,
   * like triage: each triage (the window's, a late run's) queues its own.
   */
  enqueueFlakyCheck: (target: FailureTarget, key?: string) => Promise<void>;
  /** Re-reads the repository's `.pipeheal.yml` (P3.7). Idempotent: one job per failure. */
  enqueuePolicyFile: (target: FailureTarget) => Promise<void>;
  /**
   * Dispatches the healer if the failure is healable (P4.8). Idempotent per `key`, like the flaky
   * check that queues it; `delayMs` when a busy repository makes it look again later.
   */
  enqueueDispatch: (target: FailureTarget, key?: string, delayMs?: number) => Promise<void>;
}

/** A busy repository (an attempt in flight) is looked at again every 10 minutes, for 6 hours. */
export const BUSY_RETRY_MS = 10 * 60_000;
export const MAX_BUSY_WAITS = 36;

export interface FailuresDeps extends TriageDeps, FlakyCheckDeps, DispatchDeps {
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
  if (!JOB_NAMES.has(job.name)) {
    throw new UnrecoverableError(`unknown failures job "${job.name}"`);
  }
  const target = targetSchema.parse(job.data);
  const log = deps.logger.child({ jobId: job.id, failureId: target.failureId });
  try {
    if (job.name === "close-window") {
      const system = await forSystem(deps.db, target.orgId, "collection-window");
      const failure = await system.failures.closeWindow(target.failureId);
      log.info({ closedAt: failure.windowClosedAt }, "collection window closed");
      await deps.jobs.enqueuePolicyFile(target);
      await deps.jobs.enqueueTriage(target);
      return;
    }
    await assertNotPaused(deps.pacing, target.installationId);
    try {
      if (job.name === "recent-changes") {
        await resolveRecentChanges(deps, target, log);
        return;
      }
      if (job.name === "flaky-check") {
        await checkFlaky(deps, target, log);
        await deps.jobs.enqueueDispatch(target, jobKey("flaky-check", job.id, target.failureId));
        return;
      }
      if (job.name === "dispatch") {
        const outcome = await dispatchFailure(deps, target, log);
        if (outcome === "busy") await waitForRepository(deps, target, job.id, log);
        return;
      }
      if (job.name === "policy-file") {
        await refreshFailurePolicyFile(deps, target, log);
        return;
      }
      await triageFailure(deps, target, log);
      await deps.jobs.enqueueRecentChanges(target);
      await deps.jobs.enqueueFlakyCheck(target, triageKey(job.id, target.failureId));
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

/** A late run's triage job ID ends with its key (`triage-<failure>-<run>-<attempt>`). */
function triageKey(jobId: string | undefined, failureId: string): string | undefined {
  return jobKey("triage", jobId, failureId);
}

/** The key a job's ID ends with (`<name>-<failure>-<key>`), if it has one. */
function jobKey(name: string, jobId: string | undefined, failureId: string): string | undefined {
  const prefix = `${name}-${failureId}-`;
  return jobId?.startsWith(prefix) === true ? jobId.slice(prefix.length) : undefined;
}

/** Looks again later while the repository is busy, and gives up after MAX_BUSY_WAITS. */
async function waitForRepository(
  deps: FailuresDeps,
  target: FailureTarget,
  jobId: string | undefined,
  log: Logger,
): Promise<void> {
  const key = jobKey("dispatch", jobId, target.failureId);
  const match = key === undefined ? null : /^(.*?)-?wait-(\d+)$/.exec(key);
  // The key without its wait count: the flaky check's key, or none.
  const base = match === null ? key : match[1] === "" ? undefined : match[1];
  const waits = match === null ? 0 : Number(match[2]);
  if (waits >= MAX_BUSY_WAITS) {
    const system = await forSystem(deps.db, target.orgId, "dispatcher");
    await system.failures.settle(target.failureId, {
      status: "SKIPPED",
      reason: "another attempt kept the repository busy for 6 hours",
    });
    log.info("dispatch gave up waiting for the repository");
    return;
  }
  const next = `${base === undefined ? "" : `${base}-`}wait-${String(waits + 1)}`;
  await deps.jobs.enqueueDispatch(target, next, BUSY_RETRY_MS);
  log.info({ waits: waits + 1 }, "repository busy: dispatch looks again later");
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
    async enqueueRecentChanges(target) {
      await queue.add("recent-changes", jobData(target), {
        jobId: `recent-changes-${target.failureId}`,
      });
    },
    async enqueueFlakyCheck(target, key) {
      await queue.add("flaky-check", jobData(target), {
        jobId: `flaky-check-${target.failureId}${key === undefined ? "" : `-${key}`}`,
      });
    },
    async enqueueDispatch(target, key, delayMs) {
      await queue.add("dispatch", jobData(target), {
        jobId: `dispatch-${target.failureId}${key === undefined ? "" : `-${key}`}`,
        ...(delayMs === undefined ? {} : { delay: delayMs }),
      });
    },
    async enqueuePolicyFile(target) {
      await queue.add("policy-file", jobData(target), {
        jobId: `policy-file-${target.failureId}`,
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
