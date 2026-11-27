// The step loop's routes (SPEC §7.3, D15). `POST /v1/step` accepts the runner's step and queues the
// model turn (202 at once); `GET /v1/step/:stepSeq` long-polls for the outcome. Both authenticate
// the session token in `onRequest`, before any body is read (P4.1b review M6). A session has at
// most one POST and one GET in flight, its own rate limit, and step bodies being read are capped
// per org and overall. Everything the runner sends is re-validated, and what is stored is
// redacted and bounded first: it reaches the model later, as untrusted text.
import { createHash } from "node:crypto";
import { redactLog } from "@pipeheal/agent-core";
import type { RunnerSessions, StepAcceptance, StepView, SystemScope } from "@pipeheal/db";
import { repoPathProblem } from "@pipeheal/shared/repo-path";
import {
  BODY_LIMITS,
  LIMITS,
  stepAcceptedSchema,
  stepPollResponseSchema,
  stepRequestSchema,
  type StepPollResponse,
  type StepRequest,
} from "@pipeheal/shared/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError, z } from "zod";
import { inventoryRecord } from "./inventory";
import { hashSessionToken } from "./session";

type Attempts = Pick<SystemScope["attempts"], "acceptStep" | "getStep">;

export interface StepSession {
  attemptId: string;
  orgId: string;
  repoId: string;
}

export interface StepRouteDeps {
  sessions: Pick<RunnerSessions, "authenticate">;
  /** The attempts helpers of the session's org (`forSystem(db, orgId, "gateway").attempts`). */
  attempts: (orgId: string) => Promise<Attempts>;
  /** The policy's model-turn cap for the attempt's repository. */
  maxIterations: (session: StepSession) => Promise<number>;
  enqueueTurn: (job: { orgId: string; attemptId: string; stepSeq: number }) => Promise<void>;
  now?: () => Date;
  /** How long a GET waits for a pending turn, and how often it looks. */
  longPollMs?: number;
  pollIntervalMs?: number;
}

/** Step bodies read at once, overall and per org (each up to BODY_LIMITS.step). */
export const MAX_STEP_BODIES_IN_FLIGHT = 16;
export const MAX_STEP_BODIES_PER_ORG = 4;
/** Step-route requests per session and minute: a loop needs a few per step. */
export const SESSION_STEP_RATE_LIMIT = { max: 120, timeWindow: 60_000 } as const;
export const LONG_POLL_MS = 20_000;
const POLL_INTERVAL_MS = 500;
/** What a runner waits before polling again after a `pending` answer. */
const RETRY_AFTER_MS = 1_000;
/** The file tree kept for the model: SPEC §7.1 wants the top level, not the whole repository. */
export const MAX_TREE_ENTRIES = 2_000;
export const MAX_TREE_CHARS = 200_000;

const stepSeqParam = z.strictObject({
  stepSeq: z
    .string()
    .regex(/^[1-9]\d{0,3}$/)
    .transform(Number),
});

/** Redacted, then cut back to the protocol's limit (markers can be longer than what they hide). */
function redactOutput(output: string): { output: string; truncated: boolean } {
  const text = redactLog(output).text;
  return text.length <= LIMITS.toolOutputChars
    ? { output: text, truncated: false }
    : { output: text.slice(0, LIMITS.toolOutputChars), truncated: true };
}

/** Bounded and redacted paths (file names can hold secrets too); invalid results dropped. */
export function boundedPaths(paths: readonly string[]): string[] {
  const kept: string[] = [];
  let chars = 0;
  for (const path of paths) {
    if (kept.length >= MAX_TREE_ENTRIES || chars + path.length > MAX_TREE_CHARS) break;
    kept.push(path);
    chars += path.length + 1;
  }
  if (kept.length === 0) return [];
  return redactLog(kept.join("\n"))
    .text.split("\n")
    .filter((path) => repoPathProblem(path) === null);
}

/** The copy of a step that is stored. */
function stored(request: StepRequest): StepRequest {
  if ("start" in request) {
    const { start } = request;
    return {
      ...request,
      start: {
        ...start,
        check: { ...start.check, output: redactOutput(start.check.output).output },
        fileTree: boundedPaths(start.fileTree),
        reports: start.reports.map((report) => ({
          ...report,
          path: boundedPaths([report.path])[0] ?? "report.xml",
        })),
      },
    };
  }
  return {
    ...request,
    toolResults: request.toolResults.map((result) => {
      const { output, truncated } = redactOutput(result.output);
      return { ...result, output, truncated: truncated || (result.truncated ?? false) };
    }),
  };
}

function pollAnswer(view: StepView): StepPollResponse {
  if (view.status === "PENDING") {
    return { status: "pending", stepSeq: view.stepSeq, retryAfterMs: RETRY_AFTER_MS };
  }
  if (view.status === "READY" && view.toolCalls !== null) {
    return { status: "ready", stepSeq: view.stepSeq, toolCalls: view.toolCalls };
  }
  return {
    status: "done",
    stepSeq: view.stepSeq,
    outcome: view.outcome ?? "stopped",
    reason: view.reason ?? "the step's stored tool calls are invalid",
  };
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * What a request holds: its session's lock (one POST, one GET/HEAD per session) and, for a POST,
 * a step-body slot. Released only once the socket has closed and no handler is still working,
 * whichever comes last, so neither an abort nor a slow handler can leak or bypass them.
 */
interface Hold {
  session: StepSession;
  tokenHash: string;
  lock: string;
  body: boolean;
  closed: boolean;
  running: number;
  released: boolean;
}

/** What the routes hold right now: locks and step-body slots (for tests and metrics). */
export interface StepRoutesState {
  holding(): { locks: number; bodies: number; orgs: number };
}

export function registerStepRoutes(app: FastifyInstance, deps: StepRouteDeps): StepRoutesState {
  const now = deps.now ?? (() => new Date());
  const longPollMs = deps.longPollMs ?? LONG_POLL_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  const holds = new WeakMap<FastifyRequest, Hold>();
  const locks = new Set<string>();
  const bodies = { total: 0, byOrg: new Map<string, number>() };

  function release(hold: Hold): void {
    if (hold.released || !hold.closed || hold.running > 0) return;
    hold.released = true;
    locks.delete(hold.lock);
    if (hold.body) {
      bodies.total -= 1;
      const left = (bodies.byOrg.get(hold.session.orgId) ?? 1) - 1;
      if (left <= 0) bodies.byOrg.delete(hold.session.orgId);
      else bodies.byOrg.set(hold.session.orgId, left);
    }
  }

  /** Runs a handler for a request that still holds its lock; the lock outlives the handler. */
  async function held(
    request: FastifyRequest,
    reply: FastifyReply,
    work: (hold: Hold) => Promise<FastifyReply>,
  ): Promise<FastifyReply> {
    const hold = holds.get(request);
    if (hold === undefined || hold.released) {
      return reply.code(401).send({ error: "invalid session" });
    }
    hold.running += 1;
    try {
      return await work(hold);
    } finally {
      hold.running -= 1;
      release(hold);
    }
  }

  void app.register((scoped, _options, done) => {
    // Before the body is read: who is asking, and whether they may send one now.
    scoped.addHook("onRequest", async (request, reply) => {
      const token = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(
        request.headers.authorization ?? "",
      )?.[1];
      const tokenHash = token === undefined ? null : hashSessionToken(token);
      const session =
        tokenHash === null ? null : await deps.sessions.authenticate(tokenHash, now());
      if (session === null || tokenHash === null) {
        return reply.code(401).send({ error: "invalid session" });
      }
      // The client may have gone while we looked the session up: take nothing for it.
      if (request.raw.destroyed || reply.raw.destroyed) return reply;
      const isPost = request.method === "POST";
      const lock = `${isPost ? "POST" : "GET"} ${session.attemptId}`;
      if (locks.has(lock)) {
        return reply.code(409).send({ error: "another request of this session is in flight" });
      }
      if (isPost) {
        const orgBodies = bodies.byOrg.get(session.orgId) ?? 0;
        if (bodies.total >= MAX_STEP_BODIES_IN_FLIGHT || orgBodies >= MAX_STEP_BODIES_PER_ORG) {
          return reply.code(503).send({ error: "busy, retry shortly" });
        }
        bodies.total += 1;
        bodies.byOrg.set(session.orgId, orgBodies + 1);
      }
      locks.add(lock);
      const hold: Hold = {
        session: { attemptId: session.attemptId, orgId: session.orgId, repoId: session.repoId },
        tokenHash,
        lock,
        body: isPost,
        closed: false,
        running: 0,
        released: false,
      };
      holds.set(request, hold);
      // Always emitted, whether the response finished or the connection dropped.
      reply.raw.once("close", () => {
        hold.closed = true;
        release(hold);
      });
      return undefined;
    });
    // Per session (SPEC §12), on the shared store, once we know whose session it is.
    scoped.addHook(
      "onRequest",
      scoped.rateLimit({
        ...SESSION_STEP_RATE_LIMIT,
        keyGenerator: (request) => `session:${holds.get(request)?.session.attemptId ?? "none"}`,
      }),
    );

    scoped.post("/v1/step", { bodyLimit: BODY_LIMITS.step }, (request, reply) =>
      held(request, reply, async ({ session }) => {
        const body = stepRequestSchema.safeParse(request.body);
        if (!body.success) return reply.code(400).send({ error: "invalid step" });

        const attempts = await deps.attempts(session.orgId);
        let accepted: StepAcceptance;
        try {
          accepted = await attempts.acceptStep(session.attemptId, {
            request: stored(body.data),
            // The body as received: a retry sends the same JSON, so the same hash.
            requestHash: createHash("sha256").update(JSON.stringify(request.body)).digest("hex"),
            now: now(),
            maxIterations: await deps.maxIterations(session),
            // Step 1: the baseline tests, parsed here from the raw reports (SPEC §8.6, P5.1a).
            ...("start" in body.data ? { baseline: inventoryRecord(body.data.start.reports) } : {}),
          });
        } catch (error) {
          if (error instanceof ZodError) return reply.code(400).send({ error: "invalid step" });
          throw error;
        }
        if (accepted.result === "conflict") {
          request.log.warn(
            { attemptId: session.attemptId, reason: accepted.reason },
            "step refused",
          );
          return reply.code(409).send({ error: accepted.reason });
        }
        const job = {
          orgId: session.orgId,
          attemptId: session.attemptId,
          stepSeq: body.data.stepSeq,
        };
        // A duplicate re-queues a still-pending turn, in case the first enqueue was lost.
        const queue =
          accepted.result === "accepted" ? accepted.queueTurn : accepted.step.status === "PENDING";
        if (queue) await deps.enqueueTurn(job);
        request.log.info(
          { attemptId: session.attemptId, stepSeq: job.stepSeq, result: accepted.result },
          "step accepted",
        );
        return reply.code(202).send(stepAcceptedSchema.parse({ stepSeq: job.stepSeq }));
      }),
    );

    scoped.get("/v1/step/:stepSeq", (request, reply) =>
      held(request, reply, async ({ session, tokenHash }) => {
        const params = stepSeqParam.safeParse(request.params);
        if (!params.success) return reply.code(400).send({ error: "invalid step number" });

        const attempts = await deps.attempts(session.orgId);
        const deadline = Date.now() + longPollMs;
        let view = await attempts.getStep(session.attemptId, params.data.stepSeq);
        while (view?.status === "PENDING" && Date.now() < deadline && !request.raw.destroyed) {
          await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
          // A session revoked meanwhile (contested) gets nothing more.
          if ((await deps.sessions.authenticate(tokenHash, now())) === null) {
            return reply.code(401).send({ error: "invalid session" });
          }
          view = await attempts.getStep(session.attemptId, params.data.stepSeq);
        }
        if (view === null) return reply.code(404).send({ error: "no such step" });
        return reply.code(200).send(stepPollResponseSchema.parse(pollAnswer(view)));
      }),
    );
    done();
  });

  return {
    holding: () => ({ locks: locks.size, bodies: bodies.total, orgs: bodies.byOrg.size }),
  };
}
