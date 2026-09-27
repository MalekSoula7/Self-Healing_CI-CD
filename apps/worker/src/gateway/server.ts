import { redactText } from "@pipeheal/shared";
import type { Logger } from "@pipeheal/shared/logger";
import Fastify from "fastify";

// The agent gateway that healer runners talk to (SPEC §3). Phase 0: health only.

export type HealthCheck = () => Promise<boolean>;

export interface GatewayOptions {
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

export function buildGateway({ logger, checks, checkTimeoutMs = 2000 }: GatewayOptions) {
  // Fastify's built-in request logging includes the full URL, so it is replaced by our own line.
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: 1024 * 1024,
    disableRequestLogging: true,
  });

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

  // The default 404 message echoes the full URL, query string included.
  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: "not found" }));

  app.get("/health", async (_request, reply) => {
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

export type Gateway = ReturnType<typeof buildGateway>;
