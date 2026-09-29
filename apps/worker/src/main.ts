import Anthropic from "@anthropic-ai/sdk";
import { createDb } from "@pipeheal/db";
import { createGitHubApp, type GitHubApp } from "@pipeheal/github";
import { createLogger } from "@pipeheal/shared/logger";
import { loadWorkerEnv } from "./env";
import { redisPacing } from "./pacing";
import { buildGateway } from "./gateway/server";
import { createFailuresQueue, createFailuresWorker, failureJobs } from "./queues/failures";
import { createMaintenanceQueue, createMaintenanceWorker } from "./queues/maintenance";
import { createWebhooksQueue, createWebhooksWorker } from "./queues/webhooks";
import { createRedis, pingRedis } from "./redis";
import { createShutdown } from "./shutdown";
import { triageModel, type TriageModel } from "./triage-model";

async function main(): Promise<void> {
  const env = loadWorkerEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, service: "worker" });

  const db = createDb(env.DATABASE_URL);
  const redis = createRedis(env.REDIS_URL, logger);
  const pacing = redisPacing(redis, logger);
  const maintenanceQueue = createMaintenanceQueue(redis, logger);
  const maintenanceWorker = createMaintenanceWorker(redis, logger);

  // Repository/workflow sync (P1.6) needs the App; other queues don't, so it stays optional
  // until the GitHub App is registered (CHECKPOINT 1a), same fallback as web's sign-in.
  const githubApp: GitHubApp | null =
    env.GITHUB_APP_ID === undefined || env.GITHUB_APP_PRIVATE_KEY === undefined
      ? null
      : createGitHubApp({
          appId: env.GITHUB_APP_ID,
          privateKey: env.GITHUB_APP_PRIVATE_KEY,
          log: logger,
          onRateLimit: (installationId, state) => {
            pacing.record(installationId, state);
          },
        });
  // Optional in development only (env.ts); the env check guarantees TRIAGE_MODEL has a price.
  const triagePrice = env.MODEL_PRICES?.[env.TRIAGE_MODEL];
  const triage: TriageModel | null =
    env.ANTHROPIC_API_KEY === undefined || triagePrice === undefined
      ? null
      : triageModel({
          client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 60_000 }),
          model: env.TRIAGE_MODEL,
          price: triagePrice,
          logger,
        });
  const failuresQueue = createFailuresQueue(redis, logger);
  const jobs = failureJobs(failuresQueue);
  const failuresWorker = createFailuresWorker(redis, {
    db,
    githubApp,
    logger,
    pacing,
    jobs,
    triageModel: triage,
  });
  const webhooksQueue = createWebhooksQueue(redis, logger);
  const webhooksWorker = createWebhooksWorker(redis, {
    db,
    githubApp,
    logger,
    failureJobs: jobs,
    pacing,
  });

  const gateway = buildGateway({ logger, checks: { redis: () => pingRedis(redis) } });

  const shutdown = createShutdown({
    logger,
    steps: [
      { name: "gateway", close: () => gateway.close() },
      { name: "webhooks worker", close: () => webhooksWorker.close() },
      { name: "webhooks queue", close: () => webhooksQueue.close() },
      { name: "failures worker", close: () => failuresWorker.close() },
      { name: "failures queue", close: () => failuresQueue.close() },
      { name: "maintenance worker", close: () => maintenanceWorker.close() },
      { name: "maintenance queue", close: () => maintenanceQueue.close() },
      { name: "redis", close: () => redis.quit() },
      { name: "database", close: () => db.$disconnect() },
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
  if (githubApp === null) logger.warn("GitHub App not configured: webhook repo sync is disabled");
  if (triage === null) logger.warn("ANTHROPIC_API_KEY not set: unclassified jobs stay unknown");
  logger.info("worker started");
}

main().catch((error: unknown) => {
  // Before the logger exists (e.g. invalid env), write the message only: no stack, no values.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`worker failed to start: ${message}\n`);
  process.exit(1);
});
