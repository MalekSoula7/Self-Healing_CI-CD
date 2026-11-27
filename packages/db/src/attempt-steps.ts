// The runner <-> gateway step loop (SPEC §7.3, D15), as stored: one AgentStep per `stepSeq` and the
// attempt's AgentEvent timeline. These helpers hold the loop's rules, inside one transaction each:
// steps come in order, each answers exactly the previous step's tool calls, a retried step is
// recognised by its hash, a turn completes once, and the attempt's status follows the outcome.
// Used through the system scope (`forSystem(...).attempts`), so every query is org-scoped.
import {
  LIMITS,
  stepRequestSchema,
  toolCallSchema,
  type ToolCall,
} from "@pipeheal/shared/protocol";
import { z } from "zod";
import { auditTarget, writeAudit, type Actor } from "./audit";
import type { Db } from "./client";
import { ConflictError, NotFoundError } from "./errors";
import { Prisma, type AgentStep } from "./generated/prisma/client";
import type { AgentEventType } from "./generated/prisma/enums";

const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const reasonSchema = z.string().trim().min(1).max(4_000);
const stepSeqSchema = z.int().min(1).max(LIMITS.maxStepSeq);

const acceptSchema = z.strictObject({
  /** Re-validated here: the runner is never trusted. Tool output arrives already redacted. */
  request: stepRequestSchema,
  /** SHA-256 of the request body as received. */
  requestHash: hashSchema,
  now: z.date(),
  /** The policy's model-turn cap for this attempt (`limits.maxIterationsPerAttempt`). */
  maxIterations: z.int().min(1).max(500),
});
export type StepInput = z.input<typeof acceptSchema>;

const modelCallSchema = z.strictObject({
  model: z.string().min(1).max(200),
  promptVersion: z.string().min(1).max(100),
  inputTokens: z.int().min(0),
  outputTokens: z.int().min(0),
  durationMs: z.int().min(0),
  /** What the model said besides its tool calls (its stated hypothesis), bounded. */
  text: z.string().max(LIMITS.textChars).optional(),
});

const toolCallsSchema = z
  .array(toolCallSchema)
  .min(1)
  .max(LIMITS.toolCallsPerStep)
  .refine(
    (calls) => new Set(calls.map((call) => call.callId)).size === calls.length,
    "call IDs must be unique",
  );

/** The fast policy check of the edits this turn saw (SPEC §7.2), one entry per edit result. */
const policyChecksSchema = z
  .array(
    z.strictObject({
      callId: z.string().min(1).max(64),
      violations: z
        .array(
          z.strictObject({
            ruleId: z.string().min(1).max(100),
            message: z.string().max(1_000),
            path: z.string().max(4_096).nullable(),
          }),
        )
        .max(50),
    }),
  )
  .max(LIMITS.toolCallsPerStep);

const turnSchema = z.union([
  z.strictObject({
    toolCalls: toolCallsSchema,
    model: modelCallSchema,
    policyChecks: policyChecksSchema.optional(),
  }),
  z.strictObject({
    done: z.enum(["submit", "gave_up", "stopped"]),
    reason: reasonSchema,
    model: modelCallSchema.optional(),
    policyChecks: policyChecksSchema.optional(),
  }),
]);
export type TurnInput = z.input<typeof turnSchema>;

export type StepOutcome = "submit" | "gave_up" | "not_reproducible" | "stopped";

export type StepAcceptance =
  | { result: "accepted"; step: AgentStep; queueTurn: boolean }
  | { result: "duplicate"; step: AgentStep }
  | { result: "conflict"; reason: string };

/** A step as the runner sees it, with its tool calls re-validated on read. */
export interface StepView {
  stepSeq: number;
  status: AgentStep["status"];
  toolCalls: ToolCall[] | null;
  outcome: StepOutcome | null;
  reason: string | null;
}

const OUTCOMES: readonly StepOutcome[] = ["submit", "gave_up", "not_reproducible", "stopped"];

function stepView(step: AgentStep): StepView {
  const calls = step.toolCalls === null ? null : toolCallsSchema.safeParse(step.toolCalls);
  const outcome = OUTCOMES.find((value) => value === step.outcome) ?? null;
  return {
    stepSeq: step.stepSeq,
    status: step.status,
    toolCalls: calls?.success === true ? calls.data : null,
    outcome,
    reason: step.reason,
  };
}

/** The attempt status each loop outcome leads to. */
const STATUS_AFTER = {
  submit: "AWAITING_SUBMISSION",
  gave_up: "GAVE_UP",
  not_reproducible: "NOT_REPRODUCIBLE",
  stopped: "FAILED",
} as const;

function sameIds(expected: readonly string[], received: readonly string[]): boolean {
  if (expected.length !== received.length) return false;
  const want = new Set(expected);
  return new Set(received).size === received.length && received.every((id) => want.has(id));
}

interface NewEvent {
  type: AgentEventType;
  payload: Prisma.InputJsonObject;
}

export function attemptSteps(db: Db, orgId: string, actor: Actor) {
  async function addEvents(
    tx: Prisma.TransactionClient,
    attemptId: string,
    stepSeq: number,
    events: NewEvent[],
  ): Promise<void> {
    const last = await tx.agentEvent.findFirst({
      where: { orgId, attemptId },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    let seq = (last?.seq ?? 0) + 1;
    for (const event of events) {
      await tx.agentEvent.create({
        data: { orgId, attemptId, stepSeq, seq, type: event.type, payload: event.payload },
      });
      seq += 1;
    }
  }

  /**
   * Ends a RUNNING attempt. Compare-and-set: when another writer (a contested session) changed
   * the status meanwhile, the whole transaction rolls back instead of overwriting it.
   */
  async function endAttempt(
    tx: Prisma.TransactionClient,
    attemptId: string,
    outcome: StepOutcome,
    reason: string,
    now: Date,
  ): Promise<void> {
    const { count } = await tx.healAttempt.updateMany({
      where: { id: attemptId, orgId, status: "RUNNING" },
      data: {
        status: STATUS_AFTER[outcome],
        endReason: reason.slice(0, 1_000),
        // A submission is still to come; every other outcome ends the attempt here.
        ...(outcome === "submit" ? {} : { finishedAt: now }),
      },
    });
    if (count === 0) throw new ConflictError("the attempt changed meanwhile");
  }

  /** Runs `work` again once when a concurrent writer won a compare-and-set (state is settled). */
  async function settled<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      return work();
    }
  }

  return {
    /**
     * Accepts the runner's step `stepSeq` (SPEC §7.3, D15). In order: a retry of a stored step
     * with the same body is a duplicate (idempotent), with another body a conflict; the attempt
     * must be RUNNING within its session; the step must be the next one and answer the previous
     * step's tool calls exactly (step 1 carries the start instead). A failure that didn't
     * reproduce, or a spent iteration cap, ends the loop here without a model turn.
     */
    async acceptStep(attemptId: string, input: StepInput): Promise<StepAcceptance> {
      const data = acceptSchema.parse(input);
      const { request, now } = data;
      const accept = () =>
        db.$transaction(async (tx): Promise<StepAcceptance> => {
          const attempt = await tx.healAttempt.findFirst({
            where: { id: attemptId, orgId },
            include: {
              org: { select: { status: true } },
              failure: {
                select: { repo: { select: { enabled: true, removedFromInstallationAt: true } } },
              },
            },
          });
          if (attempt === null) throw new NotFoundError("attempt not found");

          const existing = await tx.agentStep.findFirst({
            where: { orgId, attemptId, stepSeq: request.stepSeq },
          });
          if (existing !== null) {
            return existing.requestHash === data.requestHash
              ? { result: "duplicate" as const, step: existing }
              : {
                  result: "conflict" as const,
                  reason: "this step was already sent with other content",
                };
          }
          if (attempt.status !== "RUNNING") {
            return { result: "conflict" as const, reason: "the attempt isn't running" };
          }
          if (attempt.sessionExpiresAt === null || attempt.sessionExpiresAt <= now) {
            return { result: "conflict" as const, reason: "the session has expired" };
          }
          const last = await tx.agentStep.findFirst({
            where: { orgId, attemptId },
            orderBy: { stepSeq: "desc" },
          });
          const expected = (last?.stepSeq ?? 0) + 1;
          if (request.stepSeq !== expected) {
            return { result: "conflict" as const, reason: `expected step ${String(expected)}` };
          }

          const events: NewEvent[] = [];
          if ("start" in request) {
            if (last !== null) return { result: "conflict" as const, reason: "only step 1 starts" };
            const { start } = request;
            events.push({
              type: "INFO",
              payload: {
                kind: "start",
                reproduced: start.reproduced,
                check: start.check,
                fileTree: start.fileTree,
                // Only sizes here: keeping the baseline reports for the behavioral check (§8.6)
                // comes with the submission (SPEC §15).
                reports: start.reports.map((report) => ({
                  path: report.path,
                  chars: report.xml.length,
                })),
              },
            });
          } else {
            if (last?.status !== "READY") {
              return {
                result: "conflict" as const,
                reason: "no tool calls are waiting for results",
              };
            }
            const calls = stepView(last).toolCalls ?? [];
            const answered = request.toolResults.map((result) => result.callId);
            if (
              !sameIds(
                calls.map((call) => call.callId),
                answered,
              )
            ) {
              return {
                result: "conflict" as const,
                reason: "the results don't answer the previous step's tool calls",
              };
            }
            for (const result of request.toolResults) {
              events.push({
                type: "TOOL_RESULT",
                payload: {
                  callId: result.callId,
                  ok: result.ok,
                  output: result.output,
                  truncated: result.truncated ?? false,
                },
              });
            }
          }

          const { repo } = attempt.failure;
          let ending: { outcome: StepOutcome; reason: string } | null = null;
          if (
            attempt.org.status !== "ACTIVE" ||
            !repo.enabled ||
            repo.removedFromInstallationAt !== null
          ) {
            ending = { outcome: "stopped", reason: "the organization or repository was disabled" };
          } else if ("start" in request && !request.start.reproduced) {
            ending = {
              outcome: "not_reproducible",
              reason: "the failing check passed before any change",
            };
          } else if (attempt.iterations >= data.maxIterations) {
            ending = { outcome: "stopped", reason: "iteration cap reached" };
          }

          const step = await tx.agentStep.create({
            data: {
              orgId,
              attemptId,
              stepSeq: request.stepSeq,
              requestHash: data.requestHash,
              ...(ending === null
                ? {}
                : { status: "DONE", outcome: ending.outcome, reason: ending.reason }),
            },
          });
          await addEvents(tx, attemptId, request.stepSeq, events);
          if (ending !== null) await endAttempt(tx, attemptId, ending.outcome, ending.reason, now);
          await writeAudit(tx, orgId, actor, {
            action: "attempt.step_accepted",
            target: auditTarget("attempt", attemptId),
            metadata: {
              stepSeq: request.stepSeq,
              status: step.status,
              ...(ending === null ? {} : { outcome: ending.outcome }),
            },
          });
          return { result: "accepted" as const, step, queueTurn: ending === null };
        });
      try {
        return await settled(accept);
      } catch (error) {
        // Two requests raced to create the same step: the loser is told so, never a 500.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return { result: "conflict", reason: "this step is already being accepted" };
        }
        throw error;
      }
    },

    /** The runner's view of step `stepSeq`, or null when it doesn't exist. */
    async getStep(attemptId: string, stepSeq: number): Promise<StepView | null> {
      const seq = stepSeqSchema.safeParse(stepSeq);
      if (!seq.success) return null;
      const step = await db.agentStep.findFirst({
        where: { orgId, attemptId, stepSeq: seq.data },
      });
      return step === null ? null : stepView(step);
    },

    /**
     * What the healer's first message is built from (SPEC §7.1): the attempt, its repository,
     * the failure's triage and recent changes, and each failed job's redacted error window.
     * Null when the attempt isn't this org's.
     */
    async brief(attemptId: string) {
      return db.healAttempt.findFirst({
        where: { id: attemptId, orgId },
        select: {
          id: true,
          status: true,
          targetSha: true,
          failingCheck: true,
          sessionOpenedAt: true,
          failure: {
            select: {
              category: true,
              summary: true,
              headBranch: true,
              recentChanges: true,
              repo: {
                select: {
                  id: true,
                  fullName: true,
                  defaultBranch: true,
                  language: true,
                  commands: true,
                },
              },
              runs: {
                orderBy: { createdAt: "asc" },
                take: 10,
                select: {
                  // Only jobs with evidence: a run's other jobs could crowd out the failing one.
                  jobs: {
                    where: { errorWindow: { not: null }, NOT: { errorWindow: "" } },
                    orderBy: { createdAt: "asc" },
                    take: 10,
                    select: { name: true, failedStep: true, summary: true, errorWindow: true },
                  },
                },
              },
            },
          },
        },
      });
    },

    /** The attempt's timeline, oldest first: what the next model turn is built from. */
    async history(attemptId: string) {
      return db.agentEvent.findMany({
        where: { orgId, attemptId },
        orderBy: { seq: "asc" },
      });
    },

    /**
     * Stores the model's turn for a PENDING step: its next tool calls (the step becomes READY), or
     * the end of the loop (DONE, and the attempt's status follows). A turn completes once; a turn
     * for an attempt that stopped meanwhile (contested, expired) ends the step instead.
     */
    async completeTurn(attemptId: string, stepSeq: number, input: TurnInput, now = new Date()) {
      const seq = stepSeqSchema.parse(stepSeq);
      const turn = turnSchema.parse(input);
      const complete = () =>
        db.$transaction(async (tx): Promise<StepView> => {
          const attempt = await tx.healAttempt.findFirst({ where: { id: attemptId, orgId } });
          if (attempt === null) throw new NotFoundError("attempt not found");
          const step = await tx.agentStep.findFirst({ where: { orgId, attemptId, stepSeq: seq } });
          if (step === null) throw new NotFoundError("step not found");
          if (step.status !== "PENDING") return stepView(step);

          const running = attempt.status === "RUNNING";
          const expired = attempt.sessionExpiresAt === null || attempt.sessionExpiresAt <= now;
          const events: NewEvent[] = [];
          // Checks of the edits the runner reported, before the model's answer to them.
          for (const check of turn.policyChecks ?? []) {
            events.push({ type: "POLICY_CHECK", payload: check });
          }
          if (turn.model !== undefined) events.push({ type: "MODEL_CALL", payload: turn.model });
          let data: Prisma.AgentStepUpdateManyMutationInput;
          let ending: { outcome: StepOutcome; reason: string } | null = null;
          if (!running) {
            ending = { outcome: "stopped", reason: "the attempt stopped before the turn finished" };
            data = { status: "DONE", outcome: ending.outcome, reason: ending.reason };
          } else if (expired) {
            // Nobody can read the answer any more: end the attempt rather than leave it RUNNING.
            ending = { outcome: "stopped", reason: "the session expired" };
            data = { status: "DONE", outcome: ending.outcome, reason: ending.reason };
          } else if ("toolCalls" in turn) {
            for (const call of turn.toolCalls) events.push({ type: "TOOL_CALL", payload: call });
            data = { status: "READY", toolCalls: turn.toolCalls };
          } else {
            ending = { outcome: turn.done, reason: turn.reason };
            data = { status: "DONE", outcome: turn.done, reason: turn.reason };
          }

          // Only a PENDING step: a duplicate turn job can't swap the calls under the runner.
          const { count } = await tx.agentStep.updateMany({
            where: { id: step.id, orgId, status: "PENDING" },
            data,
          });
          if (count === 0) throw new ConflictError("the turn was completed meanwhile");
          const updated = await tx.agentStep.findUniqueOrThrow({ where: { id: step.id } });
          await addEvents(tx, attemptId, seq, events);
          if (running && turn.model !== undefined) {
            await tx.healAttempt.updateMany({
              where: { id: attemptId, orgId, status: "RUNNING" },
              data: { iterations: { increment: 1 } },
            });
          }
          if (running && ending !== null) {
            await endAttempt(tx, attemptId, ending.outcome, ending.reason, now);
          }
          await writeAudit(tx, orgId, actor, {
            action: "attempt.turn_completed",
            target: auditTarget("attempt", attemptId),
            metadata: {
              stepSeq: seq,
              status: updated.status,
              ...(ending === null
                ? { toolCalls: "toolCalls" in turn ? turn.toolCalls.length : 0 }
                : { outcome: ending.outcome }),
            },
          });
          return stepView(updated);
        });
      return settled(complete);
    },
  };
}
