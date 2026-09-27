import { loadWorkerEnv } from "./env";
import { buildGateway } from "./gateway/server";
import { createLogger } from "@pipeheal/shared/logger";
import { createMaintenanceQueue, createMaintenanceWorker } from "./queues/maintenance";
import { createRedis, pingRedis } from "./redis";
import { createShutdown } from "./shutdown";

async function main(): Promise<void> {
  const env = loadWorkerEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, service: "worker" });

  const redis = createRedis(env.REDIS_URL, logger);
  const maintenanceQueue = createMaintenanceQueue(redis, logger);
  const maintenanceWorker = createMaintenanceWorker(redis, logger);
  const gateway = buildGateway({ logger, checks: { redis: () => pingRedis(redis) } });

  const shutdown = createShutdown({
    logger,
    steps: [
      { name: "gateway", close: () => gateway.close() },
      { name: "maintenance worker", close: () => maintenanceWorker.close() },
      { name: "maintenance queue", close: () => maintenanceQueue.close() },
      { name: "redis", close: () => redis.quit() },
    ],
  });
  // On Windows, Ctrl+C delivers SIGINT; SIGTERM comes from container runtimes.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void shutdown(signal));
  }
  process.once("uncaughtException", (error) => {
    logger.fatal({ error: error.message }, "uncaught exception");
    void shutdown("uncaughtException");
  });
  process.once("unhandledRejection", (reason) => {
    logger.fatal(
      { error: reason instanceof Error ? reason.message : "non-error rejection" },
      "unhandled rejection",
    );
    void shutdown("unhandledRejection");
  });

  await gateway.listen({ host: env.GATEWAY_HOST, port: env.GATEWAY_PORT });
  await maintenanceQueue.add("ping", { requestedAt: new Date().toISOString() });
  logger.info("worker started");
}

main().catch((error: unknown) => {
  // Before the logger exists (e.g. invalid env), write the message only: no stack, no values.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`worker failed to start: ${message}\n`);
  process.exit(1);
});
