// `POST /v1/submission` (SPEC §2 step 10, P5.1b): the runner uploads the fix once the model has
// submitted it and the runner has run the full checks: final file contents (never a diff), the
// checks' results, and the raw JUnit reports. The session is authenticated in `onRequest`, before
// any body is read, and only an attempt waiting for its submission may send one; bodies are big
// (BODY_LIMITS.submission), so few are read at once. Nothing is trusted: the body is re-validated,
// check output is redacted, the reports are parsed here (only the inventory is kept), and the
// server later rebuilds the diff from the target commit itself (P5.1c). A retried upload of the
// same body is answered like the first.
import { createHash } from "node:crypto";
import { ConflictError, type RunnerSessions, type SystemScope } from "@pipeheal/db";
import { BODY_LIMITS, submissionSchema } from "@pipeheal/shared/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { inventoryRecord } from "./inventory";
import { hashSessionToken } from "./session";
import { redactOutput } from "./steps";

export interface SubmissionRouteDeps {
  sessions: Pick<RunnerSessions, "authenticate">;
  /** The attempts helpers of the session's org (`forSystem(db, orgId, "gateway").attempts`). */
  attempts: (orgId: string) => Promise<Pick<SystemScope["attempts"], "acceptSubmission">>;
  /** Queues the submission's validation (P5.1c). Idempotent per attempt. */
  enqueueValidation: (job: { orgId: string; attemptId: string }) => Promise<void>;
  now?: () => Date;
}

/** Submission bodies read at once, overall and per org (each up to BODY_LIMITS.submission). */
export const MAX_SUBMISSION_BODIES_IN_FLIGHT = 2;
export const MAX_SUBMISSION_BODIES_PER_ORG = 1;
/** Uploads per session and minute: one, plus the runner's retries. */
export const SESSION_SUBMISSION_RATE_LIMIT = { max: 10, timeWindow: 60_000 } as const;

/** An upload may start while waiting for it, or repeat while it is being checked. */
const MAY_UPLOAD = new Set(["AWAITING_SUBMISSION", "VALIDATING"]);

interface Hold {
  attemptId: string;
  orgId: string;
  closed: boolean;
  running: boolean;
  released: boolean;
}

export function registerSubmissionRoute(
  app: FastifyInstance,
  deps: SubmissionRouteDeps,
): {
  holding(): { sessions: number; bodies: number };
} {
  const now = deps.now ?? (() => new Date());
  const holds = new WeakMap<FastifyRequest, Hold>();
  const sessions = new Set<string>();
  const bodies = { total: 0, byOrg: new Map<string, number>() };

  // Released once the socket has closed and the handler is done, whichever comes last.
  function release(hold: Hold): void {
    if (hold.released || !hold.closed || hold.running) return;
    hold.released = true;
    sessions.delete(hold.attemptId);
    bodies.total -= 1;
    const left = (bodies.byOrg.get(hold.orgId) ?? 1) - 1;
    if (left <= 0) bodies.byOrg.delete(hold.orgId);
    else bodies.byOrg.set(hold.orgId, left);
  }

  void app.register((scoped, _options, done) => {
    scoped.addHook("onRequest", async (request, reply) => {
      const token = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(
        request.headers.authorization ?? "",
      )?.[1];
      const session =
        token === undefined
          ? null
          : await deps.sessions.authenticate(hashSessionToken(token), now());
      if (session === null) return reply.code(401).send({ error: "invalid session" });
      if (!MAY_UPLOAD.has(session.status)) {
        return reply.code(409).send({ error: "the attempt isn't waiting for a submission" });
      }
      if (request.raw.destroyed || reply.raw.destroyed) return reply;
      if (sessions.has(session.attemptId)) {
        return reply.code(409).send({ error: "another upload of this session is in flight" });
      }
      const orgBodies = bodies.byOrg.get(session.orgId) ?? 0;
      if (
        bodies.total >= MAX_SUBMISSION_BODIES_IN_FLIGHT ||
        orgBodies >= MAX_SUBMISSION_BODIES_PER_ORG
      ) {
        return reply.code(503).send({ error: "busy, retry shortly" });
      }
      sessions.add(session.attemptId);
      bodies.total += 1;
      bodies.byOrg.set(session.orgId, orgBodies + 1);
      const hold: Hold = {
        attemptId: session.attemptId,
        orgId: session.orgId,
        closed: false,
        running: false,
        released: false,
      };
      holds.set(request, hold);
      reply.raw.once("close", () => {
        hold.closed = true;
        release(hold);
      });
      return undefined;
    });
    scoped.addHook(
      "onRequest",
      scoped.rateLimit({
        ...SESSION_SUBMISSION_RATE_LIMIT,
        keyGenerator: (request) => `submission:${holds.get(request)?.attemptId ?? "none"}`,
      }),
    );

    scoped.post("/v1/submission", { bodyLimit: BODY_LIMITS.submission }, async (request, reply) => {
      const hold = holds.get(request);
      if (hold === undefined || hold.released) {
        return reply.code(401).send({ error: "invalid session" });
      }
      hold.running = true;
      try {
        const body = submissionSchema.safeParse(request.body);
        if (!body.success) return await reply.code(400).send({ error: "invalid submission" });
        const attempts = await deps.attempts(hold.orgId);
        let accepted: Awaited<ReturnType<typeof attempts.acceptSubmission>>;
        try {
          accepted = await attempts.acceptSubmission(hold.attemptId, {
            // The body as received: a retry sends the same JSON, so the same hash.
            requestHash: createHash("sha256").update(JSON.stringify(request.body)).digest("hex"),
            files: body.data.files,
            checks: body.data.checks.map((check) => ({
              ...check,
              output: redactOutput(check.output).output,
            })),
            afterTests: inventoryRecord(body.data.reports),
          });
        } catch (error) {
          if (error instanceof ZodError) {
            return await reply.code(400).send({ error: "invalid submission" });
          }
          if (error instanceof ConflictError) {
            return await reply.code(409).send({ error: "the attempt changed" });
          }
          throw error;
        }
        if (accepted.result === "conflict") {
          request.log.warn(
            { attemptId: hold.attemptId, reason: accepted.reason },
            "submission refused",
          );
          return await reply.code(409).send({ error: accepted.reason });
        }
        // Queued again for a duplicate too: the job is idempotent, and its first queueing may
        // have been lost.
        await deps.enqueueValidation({ orgId: hold.orgId, attemptId: hold.attemptId });
        request.log.info(
          { attemptId: hold.attemptId, files: body.data.files.length, result: accepted.result },
          "submission received",
        );
        return await reply.code(202).send({ status: "accepted" });
      } finally {
        hold.running = false;
        release(hold);
      }
    });
    done();
  });

  return {
    holding: () => ({ sessions: sessions.size, bodies: bodies.total }),
  };
}
