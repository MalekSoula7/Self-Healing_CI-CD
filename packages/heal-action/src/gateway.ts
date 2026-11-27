// The runner's side of the gateway protocol (SPEC §3.1, D15, D16). Every request is short; model
// turns are long-polled. Retries only where the server makes them safe: a step is idempotent on
// its stepSeq, polls are reads, and the session exchange is retried only while the dispatcher may
// still be recording the run (401), never after the session opened. Responses are validated.
import {
  sessionResponseSchema,
  stepAcceptedSchema,
  stepPollResponseSchema,
  type SessionResponse,
  type StepPollResponse,
  type StepRequest,
  type Submission,
} from "@pipeheal/shared/protocol";
import type { z } from "zod";

export class GatewayError extends Error {
  override readonly name = "GatewayError";

  constructor(
    /** HTTP status, or null when the gateway couldn't be reached. */
    readonly status: number | null,
    message: string,
  ) {
    super(message);
  }
}

export interface GatewayClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Per request; a long-poll holds about 20 s. */
  requestTimeoutMs?: number;
}

/** 401s while the dispatcher records the healer run (D16): about half a minute. */
const SESSION_ATTEMPTS = 7;
const SESSION_RETRY_MS = 5_000;
/** Network errors and 5xx: a few tries with backoff. */
const TRANSIENT_ATTEMPTS = 5;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

interface Answer {
  status: number;
  body: unknown;
}

export function gatewayClient(options: GatewayClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.requestTimeoutMs ?? 45_000;

  async function send(
    method: "GET" | "POST",
    path: string,
    init: { token?: string; body?: unknown },
  ): Promise<Answer> {
    let response: Response;
    try {
      response = await fetchImpl(new URL(path, options.baseUrl), {
        method,
        headers: {
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        // A redirect would carry tokens to another origin (review L6).
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new GatewayError(null, "the gateway couldn't be reached");
    }
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body };
  }

  /** Retries network errors, 5xx and 429 with backoff; returns any other answer. */
  async function withRetries(attempt: () => Promise<Answer>): Promise<Answer> {
    let last: GatewayError | null = null;
    for (let tries = 1; tries <= TRANSIENT_ATTEMPTS; tries++) {
      try {
        const answer = await attempt();
        if (answer.status < 500 && answer.status !== 429) return answer;
        last = new GatewayError(answer.status, `the gateway answered ${String(answer.status)}`);
      } catch (error) {
        if (!(error instanceof GatewayError)) throw error;
        last = error;
      }
      if (tries < TRANSIENT_ATTEMPTS) await sleep(1_000 * 2 ** (tries - 1));
    }
    throw last ?? new GatewayError(null, "the gateway didn't answer");
  }

  function parsed<T extends z.ZodType>(schema: T, answer: Answer): z.output<T> {
    const result = schema.safeParse(answer.body);
    if (!result.success) throw new GatewayError(answer.status, "unexpected gateway response");
    return result.data;
  }

  function errorOf(answer: Answer): GatewayError {
    const body = answer.body;
    const message =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error.slice(0, 300)
        : `the gateway answered ${String(answer.status)}`;
    return new GatewayError(answer.status, message);
  }

  return {
    /** Trades the OIDC token for the attempt's session (SPEC §5.4). */
    async openSession(oidcToken: string, attemptId: string): Promise<SessionResponse> {
      for (let tries = 1; ; tries++) {
        // No transient retry: a lost answer to an exchange that went through, retried, would be
        // a second exchange, and the gateway fails a contested attempt (D16, review M3).
        const answer = await send("POST", "/v1/session", { body: { oidcToken, attemptId } });
        if (answer.status === 200) return parsed(sessionResponseSchema, answer);
        // The run may not be recorded yet (D16): wait and ask again, a few times only.
        if (answer.status !== 401 || tries >= SESSION_ATTEMPTS) throw errorOf(answer);
        await sleep(SESSION_RETRY_MS);
      }
    },

    async postStep(token: string, step: StepRequest): Promise<void> {
      const answer = await withRetries(() => send("POST", "/v1/step", { token, body: step }));
      if (answer.status !== 202) throw errorOf(answer);
      const accepted = parsed(stepAcceptedSchema, answer);
      if (accepted.stepSeq !== step.stepSeq) {
        throw new GatewayError(202, "the gateway accepted another step");
      }
    },

    /** Polls until the step's turn is ready or the loop ended, or until `deadline`. */
    async waitForStep(token: string, stepSeq: number, deadline: Date): Promise<StepPollResponse> {
      for (;;) {
        const answer = await withRetries(() =>
          send("GET", `/v1/step/${String(stepSeq)}`, { token }),
        );
        if (answer.status !== 200) throw errorOf(answer);
        const poll = parsed(stepPollResponseSchema, answer);
        if (poll.stepSeq !== stepSeq) throw new GatewayError(200, "an answer for another step");
        if (poll.status !== "pending") return poll;
        if (Date.now() >= deadline.getTime()) {
          throw new GatewayError(null, "the model didn't answer before the attempt's deadline");
        }
        await sleep(poll.retryAfterMs);
      }
    },

    async submit(token: string, submission: Submission): Promise<void> {
      const answer = await withRetries(() =>
        send("POST", "/v1/submission", { token, body: submission }),
      );
      if (answer.status !== 202 && answer.status !== 200) throw errorOf(answer);
    },
  };
}

export type GatewayClient = ReturnType<typeof gatewayClient>;
