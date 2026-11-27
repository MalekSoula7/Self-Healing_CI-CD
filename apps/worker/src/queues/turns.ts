// The `turns` queue (SPEC §7.3, D15): one job per accepted step runs the next model turn and
// stores its outcome. The model is behind `TurnRunner` (P4.4 builds the real one: prompts, tool
// definitions, context, accounting). Whatever it returns is untrusted model output: tool calls get
// server-side IDs and are re-validated with the protocol's schema before a runner ever sees them.
import { randomBytes } from "node:crypto";
import type { AgentEvent, SystemScope, TurnInput } from "@pipeheal/db";
import type { Logger } from "@pipeheal/shared/logger";
import { LIMITS, toolCallSchema } from "@pipeheal/shared/protocol";
import { Queue, UnrecoverableError, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { ZodError, z } from "zod";

export const TURNS_QUEUE = "turns";

export const turnJobSchema = z.strictObject({
  orgId: z.uuid(),
  attemptId: z.uuid(),
  stepSeq: z.int().min(1).max(LIMITS.maxStepSeq),
});
export type TurnJob = z.infer<typeof turnJobSchema>;

/** One model call, as recorded in the attempt's timeline. */
export interface ModelCallSummary {
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  text?: string;
}

/** The fast policy check of one edit the runner reported (SPEC §7.2). */
export interface PolicyCheck {
  callId: string;
  violations: { ruleId: string; message: string; path: string | null }[];
}

export type TurnResult = (
  | /** Tool calls as the model wrote them, without IDs: validated here, never trusted. */
    { toolCalls: unknown[]; model: ModelCallSummary }
  | { done: "submit" | "gave_up" | "stopped"; reason: string; model?: ModelCallSummary }
) & { policyChecks?: PolicyCheck[] };

export interface TurnContext {
  orgId: string;
  attemptId: string;
  stepSeq: number;
  /** The attempt's timeline so far, oldest first. */
  history: AgentEvent[];
}

/** Runs one model turn of an attempt (P4.4). */
export interface TurnRunner {
  next(context: TurnContext): Promise<TurnResult>;
}

export interface TurnsDeps {
  /** The attempts helpers of an org's system scope (`forSystem(db, orgId, "turns").attempts`). */
  attempts: (
    orgId: string,
  ) => Promise<Pick<SystemScope["attempts"], "getStep" | "history" | "completeTurn">>;
  runner: TurnRunner;
  logger: Logger;
}

interface QueueJob {
  id?: string | undefined;
  name: string;
  data: unknown;
}

const toolCallsSchema = z.array(toolCallSchema).min(1).max(LIMITS.toolCallsPerStep);

/** The turn's policy checks, when it has any, for `completeTurn` (which validates them). */
function checksOf(result: TurnResult): { policyChecks?: PolicyCheck[] } {
  return result.policyChecks === undefined || result.policyChecks.length === 0
    ? {}
    : { policyChecks: result.policyChecks };
}

/** The job ID that makes enqueuing a step's turn idempotent. */
export function turnJobId(job: TurnJob): string {
  return `turn-${job.attemptId}-${String(job.stepSeq)}`;
}

export async function processTurnJob(job: QueueJob, deps: TurnsDeps): Promise<void> {
  if (job.name !== "turn") throw new UnrecoverableError(`unknown turns job "${job.name}"`);
  const data = turnJobSchema.parse(job.data);
  const log = deps.logger.child({ attemptId: data.attemptId, stepSeq: data.stepSeq });
  const attempts = await deps.attempts(data.orgId);
  const step = await attempts.getStep(data.attemptId, data.stepSeq);
  // Already answered (a retried job), or never accepted: nothing to do.
  if (step?.status !== "PENDING") return;

  let result: TurnResult;
  try {
    const history = await attempts.history(data.attemptId);
    result = await deps.runner.next({ ...data, history });
  } catch (error) {
    // The error's kind only: model errors can echo prompt content (P4.4 review L9).
    log.error({ error: error instanceof Error ? error.name : "non-error" }, "turn failed");
    await attempts.completeTurn(data.attemptId, data.stepSeq, {
      done: "stopped",
      reason: "the model turn failed",
    });
    return;
  }

  /**
   * Stores the turn. A result outside the stored bounds stops the loop, keeping the model's
   * tokens, rather than fail the job and call the model again on retry (P4.4 review M3).
   */
  async function store(turn: TurnInput): Promise<void> {
    try {
      await attempts.completeTurn(data.attemptId, data.stepSeq, turn);
    } catch (error) {
      if (!(error instanceof ZodError)) throw error;
      log.warn("turn refused: result outside the stored bounds");
      await attempts.completeTurn(data.attemptId, data.stepSeq, {
        done: "stopped",
        reason: "the turn's result didn't fit what is stored",
        ...(turn.model === undefined ? {} : { model: turn.model }),
      });
    }
  }

  if ("done" in result) {
    await store({
      done: result.done,
      reason: result.reason.trim() === "" ? "no reason given" : result.reason.slice(0, 4_000),
      ...(result.model === undefined ? {} : { model: result.model }),
      ...checksOf(result),
    });
    log.info({ outcome: result.done }, "turn ended the loop");
    return;
  }

  // Server-side call IDs, with a random part: results for another turn's calls never match.
  // The model's own fields go through the protocol schema as they are.
  const turnTag = randomBytes(4).toString("hex");
  const numbered = result.toolCalls.map((call, index) =>
    typeof call === "object" && call !== null
      ? { ...call, callId: `s${String(data.stepSeq)}c${String(index + 1)}-${turnTag}` }
      : call,
  );
  const calls = toolCallsSchema.safeParse(numbered);
  if (!calls.success) {
    await store({
      done: "stopped",
      reason: "the model asked for tool calls outside the protocol",
      model: result.model,
      ...checksOf(result),
    });
    log.warn("turn refused: tool calls outside the protocol");
    return;
  }
  await store({
    toolCalls: calls.data,
    model: result.model,
    ...checksOf(result),
  });
  log.info({ toolCalls: calls.data.length }, "turn ready");
}

export function createTurnsQueue(connection: Redis, prefix?: string) {
  return new Queue(TURNS_QUEUE, { connection, ...(prefix === undefined ? {} : { prefix }) });
}

export type TurnsQueue = ReturnType<typeof createTurnsQueue>;

/**
 * Queues a step's model turn; the job ID makes a repeat a no-op. A job that failed for good (its
 * retries spent, e.g. on a database outage) is retried, so a re-sent step can unstick its turn.
 */
export async function enqueueTurn(queue: TurnsQueue, job: TurnJob): Promise<void> {
  const data = turnJobSchema.parse(job);
  const jobId = turnJobId(data);
  const existing = await queue.getJob(jobId);
  if (existing !== undefined && (await existing.isFailed())) {
    await existing.retry();
    return;
  }
  await queue.add("turn", data, {
    jobId,
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: 1_000,
    removeOnFail: 1_000,
  });
}

// `prefix` isolates keys (tests use a unique one); production uses BullMQ's default.
export function createTurnsWorker(connection: Redis, deps: TurnsDeps, prefix?: string) {
  // One at a time: the GPU runs one model call at a time anyway (D11).
  const worker = new Worker(TURNS_QUEUE, (job) => processTurnJob(job, deps), {
    connection,
    concurrency: 1,
    ...(prefix === undefined ? {} : { prefix }),
  });
  worker.on("failed", (job, error) => {
    deps.logger.error({ jobId: job?.id, error: error.message }, "turns job failed");
  });
  worker.on("error", (error) => {
    deps.logger.error({ error: error.message }, "turns worker error");
  });
  return worker;
}
