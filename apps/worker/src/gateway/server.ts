import Fastify from "fastify";
import type { Logger } from "pino";

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

export function buildGateway({ logger, checks, checkTimeoutMs = 2000 }: GatewayOptions) {
  const app = Fastify({ loggerInstance: logger, bodyLimit: 1024 * 1024 });

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
