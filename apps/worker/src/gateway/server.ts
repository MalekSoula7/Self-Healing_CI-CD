import rateLimit from "@fastify/rate-limit";
import { redactText } from "@pipeheal/shared";
import type { Logger } from "@pipeheal/shared/logger";
import { BODY_LIMITS } from "@pipeheal/shared/protocol";
import Fastify, { LogController, type FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";

// The agent gateway that healer runners talk to (SPEC §3, D15), hardened before any runner route
// exists (P4.1b, reviewed):
// - public server: `/livez` (no dependency checks) and, from P4.2, the `/v1/*` runner routes;
//   small default body limit, header/request/idle deadlines, a connection cap, and a per-client
//   rate limit in place before any route is added (so every route and every 404 is counted);
// - internal server (loopback by default): `/readyz` with dependency states, never exposed.
// Per-session and per-org limits need a verified session: they come with the routes (P4.2).

export type HealthCheck = () => Promise<boolean>;

/** Whole-request receive deadline: a full submission on a slow runner link. */
export const REQUEST_TIMEOUT_MS = 120_000;
/** Header deadline: headers are small, so a slow trickle is an attack, not a slow link. */
export const HEADERS_TIMEOUT_MS = 10_000;
/** Idle socket deadline: longer than a long-poll hold (D15), which stays under 30 s. */
export const CONNECTION_TIMEOUT_MS = 65_000;
/** Open sockets per process; beyond it new connections are dropped. */
export const MAX_CONNECTIONS = 1_024;

export interface RateLimitOptions {
  /** Requests per window per client (an IPv4 address or an IPv6 /64). */
  max: number;
  timeWindowMs: number;
  /**
   * Shared store across gateway instances; in-memory when absent (tests). Must fail fast
   * (`createRateLimitRedis`): a store that queues commands would hang every request.
   */
  redis?: Redis;
}

/** Generous per client: many runners can share one NAT address. */
export const DEFAULT_RATE_LIMIT: Omit<RateLimitOptions, "redis"> = {
  max: 600,
  timeWindowMs: 60_000,
};

export interface GatewayOptions {
  logger: Logger;
  rateLimit?: RateLimitOptions;
  /**
   * Addresses or CIDRs of reverse proxies whose `X-Forwarded-For` is believed. Empty: the socket
   * peer is the client (a proxy in front would put every runner in one bucket).
   */
  trustedProxies?: readonly string[];
}

export interface InternalServerOptions {
  logger: Logger;
  checks: Record<string, HealthCheck>;
  checkTimeoutMs?: number;
}

async function runCheck(check: HealthCheck, timeoutMs: number): Promise<"up" | "down"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
  });
  try {
    return (await Promise.race([check(), timeout])) ? "up" : "down";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

/** The path without its query string: query strings can carry tokens and OAuth codes. */
function pathOf(url: string): string {
  const query = url.indexOf("?");
  return query === -1 ? url : url.slice(0, query);
}

/** A 4xx/5xx status carried by the error (Fastify validation, http-errors), else 500. */
function httpStatusOf(error: unknown): number {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return 500;
  const { statusCode } = error;
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 600 ? statusCode : 500;
}

/**
 * The rate-limit bucket of a client address: IPv4 as is (IPv4-mapped IPv6 too), IPv6 by its /64,
 * since every IPv6 host holds a whole /64. Never derived from headers a client chooses (a made-up
 * bearer token per request would otherwise buy a fresh budget each time).
 */
export function clientBucket(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)?.[1];
  if (mapped !== undefined) return mapped;
  if (!ip.includes(":")) return ip;
  const address = ip.split("%")[0] ?? "";
  const halves = address.split("::");
  const head = halves[0] === undefined || halves[0] === "" ? [] : halves[0].split(":");
  const tail = halves[1] === undefined || halves[1] === "" ? [] : halves[1].split(":");
  const zeros = halves.length === 2 ? Math.max(0, 8 - head.length - tail.length) : 0;
  const groups = [...head, ...Array<string>(zeros).fill("0"), ...tail].slice(0, 4);
  const prefix = groups.map((group) => (Number.parseInt(group, 16) || 0).toString(16));
  while (prefix.length < 4) prefix.push("0");
  return `${prefix.join(":")}::/64`;
}

interface ServerLimits {
  bodyLimit: number;
  trustProxy?: readonly string[];
}

/**
 * What every gateway listener shares: deadlines, a connection cap, logging without URLs or
 * headers, and error responses without internal details. The 404 handler is the caller's.
 */
function baseServer(logger: Logger, limits: ServerLimits) {
  // Typed as Fastify's base logger so plugins' hooks (rate limit) fit the instance's generics.
  const baseLogger: FastifyBaseLogger = logger;
  // Fastify's built-in request logging includes the full URL, so it is replaced by our own line.
  const app = Fastify({
    bodyLimit: limits.bodyLimit,
    requestTimeout: REQUEST_TIMEOUT_MS,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    ...(limits.trustProxy === undefined || limits.trustProxy.length === 0
      ? {}
      : { trustProxy: [...limits.trustProxy] }),
    loggerInstance: baseLogger,
    logController: new LogController({ disableRequestLogging: true }),
  });
  app.server.headersTimeout = HEADERS_TIMEOUT_MS;
  app.server.maxConnections = MAX_CONNECTIONS;

  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        path: pathOf(request.url),
        statusCode: reply.statusCode,
        responseTimeMs: Math.round(reply.elapsedTime),
      },
      "request completed",
    );
  });

  // Clients never see internal error details; logs get the redacted error only.
  // Anything can be thrown, so the error is narrowed rather than assumed.
  app.setErrorHandler(async (error: unknown, request, reply) => {
    const status = httpStatusOf(error);
    if (status >= 500) {
      request.log.error({ err: error, path: pathOf(request.url) }, "request failed");
      return reply.code(status).send({ error: "internal error" });
    }
    const message = error instanceof Error ? error.message : "bad request";
    return reply.code(status).send({ error: redactText(message) });
  });

  return app;
}

// The default 404 message echoes the full URL, query string included.
const notFoundBody = { error: "not found" } as const;

/**
 * The public gateway runners reach. Async: the rate limiter is loaded before it returns, so every
 * route added afterwards is counted. Routes that need larger bodies opt in with `BODY_LIMITS`.
 */
export async function buildGateway({
  logger,
  rateLimit: limits = DEFAULT_RATE_LIMIT,
  trustedProxies = [],
}: GatewayOptions) {
  const app = baseServer(logger, { bodyLimit: BODY_LIMITS.default, trustProxy: trustedProxies });

  // Counted in onRequest: before the body is read and before any auth work. A store error fails
  // the request (500), it never lets it through unlimited.
  await app.register(rateLimit, {
    global: true,
    hook: "onRequest",
    max: limits.max,
    timeWindow: limits.timeWindowMs,
    skipOnError: false,
    ...(limits.redis === undefined ? {} : { redis: limits.redis, nameSpace: "gateway-rate:" }),
    keyGenerator: (request) => `ip:${clientBucket(request.ip)}`,
    errorResponseBuilder: (_request, context) =>
      Object.assign(new Error(`rate limit exceeded, retry in ${context.after}`), {
        statusCode: context.statusCode,
      }),
  });

  // Liveness touches nothing (no store either), so a store outage can't fail the probe.
  app.get("/livez", { config: { rateLimit: false } }, () => ({ status: "ok", service: "gateway" }));
  app.setNotFoundHandler({ preHandler: app.rateLimit() }, async (_request, reply) =>
    reply.code(404).send(notFoundBody),
  );

  return app;
}

/** Readiness with dependency states: internal only (bound to loopback unless configured). */
export function buildInternalServer({
  logger,
  checks,
  checkTimeoutMs = 2000,
}: InternalServerOptions) {
  const app = baseServer(logger, { bodyLimit: BODY_LIMITS.default });
  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send(notFoundBody));

  app.get("/readyz", async (_request, reply) => {
    const results = Object.fromEntries(
      await Promise.all(
        Object.entries(checks).map(
          async ([name, check]) => [name, await runCheck(check, checkTimeoutMs)] as const,
        ),
      ),
    );
    const healthy = Object.values(results).every((state) => state === "up");
    return reply
      .code(healthy ? 200 : 503)
      .send({ status: healthy ? "ok" : "degraded", service: "gateway", checks: results });
  });

  return app;
}

export type Gateway = Awaited<ReturnType<typeof buildGateway>>;
export type InternalServer = ReturnType<typeof buildInternalServer>;
