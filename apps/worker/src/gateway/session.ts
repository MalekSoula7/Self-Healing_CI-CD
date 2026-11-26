// POST /v1/session (SPEC §5.4, D15, D16): a runner trades its GitHub OIDC token for the attempt's
// one session. Every refusal answers the same 401 so a caller learns nothing about attempts or
// repositories; the reason goes to the log (never a token).
import { createHash, randomBytes } from "node:crypto";
import {
  DISPATCH_TIMEOUT_MS,
  SESSION_TTL_MS,
  type AttemptForSession,
  type RunnerSessions,
} from "@pipeheal/db";
import {
  BODY_LIMITS,
  attemptCommandsSchema,
  sessionRequestSchema,
  sessionResponseSchema,
  type SessionResponse,
} from "@pipeheal/shared/protocol";
import type { FastifyInstance } from "fastify";
import type { JWTVerifyGetKey } from "jose";
import { SESSION_TAKEN, sessionProblem, verifyOidcToken } from "./oidc";

/** Session exchanges per client address and minute: a runner needs one per attempt. */
export const SESSION_RATE_LIMIT = { max: 30, timeWindow: 60_000 } as const;

export interface SessionRouteDeps {
  sessions: Pick<RunnerSessions, "find" | "open" | "contest">;
  /** GitHub's OIDC signing keys (`githubOidcKeys()`; local keys in tests). */
  keys: JWTVerifyGetKey;
  /** The App's slug, or undefined when the App isn't configured: then nothing opens a session. */
  appSlug: string | undefined;
  /** The attempt's wall-clock budget in minutes, from the repository's effective policy. */
  wallClockMinutes: (attempt: AttemptForSession) => Promise<number>;
  now?: () => Date;
}

/** SHA-256 (hex) of a session token: what is stored and looked up. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const SESSION_TTL_MINUTES = SESSION_TTL_MS / 60_000;
const attemptDetailsSchema = sessionResponseSchema.shape.attempt;

/**
 * What the runner needs to run the attempt, validated before any session opens (a stored value
 * outside the protocol must not leave a RUNNING attempt nobody holds). Commands that don't parse
 * count as not configured. The budget never outlasts the session.
 */
function attemptDetails(attempt: AttemptForSession, wallClockMinutes: number) {
  const { repo } = attempt.failure;
  const commands = attemptCommandsSchema.safeParse(repo.commands);
  return attemptDetailsSchema.safeParse({
    targetSha: attempt.targetSha,
    failingCheck: attempt.failingCheck,
    commands: commands.success ? commands.data : {},
    junitGlob: repo.junitGlob,
    wallClockMinutes: Math.min(SESSION_TTL_MINUTES, Math.max(1, Math.round(wallClockMinutes))),
  });
}

export function registerSessionRoute(app: FastifyInstance, deps: SessionRouteDeps): void {
  const now = deps.now ?? (() => new Date());

  app.post(
    "/v1/session",
    { bodyLimit: BODY_LIMITS.session, config: { rateLimit: SESSION_RATE_LIMIT } },
    async (request, reply) => {
      const body = sessionRequestSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "invalid session request" });
      if (deps.appSlug === undefined) {
        request.log.error("session refused: GITHUB_APP_SLUG isn't configured");
        return reply.code(503).send({ error: "sessions are unavailable" });
      }
      const refuse = (reason: string) => {
        request.log.warn({ attemptId: body.data.attemptId, reason }, "session refused");
        return reply.code(401).send({ error: "session refused" });
      };

      const at = now();
      const verified = await verifyOidcToken(body.data.oidcToken, deps.keys, at);
      if (!verified.ok) return refuse(verified.reason);
      const { claims } = verified;
      const ref = {
        attemptId: body.data.attemptId,
        githubRepoId: claims.repository_id,
        githubOwnerId: claims.repository_owner_id,
      };
      const attempt = await deps.sessions.find(ref);
      const problem = sessionProblem(claims, attempt, {
        appSlug: deps.appSlug,
        now: at,
        dispatchTimeoutMs: DISPATCH_TIMEOUT_MS,
      });
      if (problem === SESSION_TAKEN) {
        // The attempt's own run asked again: heal-action never does, so the session is contested.
        const stopped = await deps.sessions.contest(ref, { now: at, reason: "second exchange" });
        request.log.warn({ attemptId: body.data.attemptId, stopped }, "session contested");
        return refuse(problem);
      }
      if (problem !== null || attempt === null) return refuse(problem ?? "no attempt");

      const wallClockMinutes = await deps.wallClockMinutes(attempt);
      const details = attemptDetails(attempt, wallClockMinutes);
      if (!details.success) {
        request.log.error({ attemptId: attempt.id }, "session refused: attempt details invalid");
        return refuse("attempt details invalid");
      }
      // 32 random bytes; only the hash is stored. The session ends with the attempt's budget.
      const sessionToken = randomBytes(32).toString("base64url");
      const opened = await deps.sessions.open(ref, {
        tokenHash: hashSessionToken(sessionToken),
        now: at,
        ttlMs: details.data.wallClockMinutes * 60_000,
      });
      if (opened === null) return refuse("another exchange opened the session first");

      request.log.info({ attemptId: attempt.id, orgId: attempt.orgId }, "session opened");
      const response: SessionResponse = sessionResponseSchema.parse({
        sessionToken,
        expiresAt: opened.expiresAt.toISOString(),
        attempt: details.data,
      });
      return reply.code(200).send(response);
    },
  );
}
