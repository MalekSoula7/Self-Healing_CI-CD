import { createDb, forSystem, runnerSessions } from "@pipeheal/db";
import { createGitHubApp, type GitHubApp } from "@pipeheal/github";
import { effectivePolicy } from "@pipeheal/policy";
import { createLogger } from "@pipeheal/shared/logger";
import { loadWorkerEnv } from "./env";
import { redisPacing } from "./pacing";
import { githubOidcKeys } from "./gateway/oidc";
import { DEFAULT_RATE_LIMIT, buildGateway, buildInternalServer } from "./gateway/server";
import { registerSessionRoute } from "./gateway/session";
import { registerStepRoutes } from "./gateway/steps";
import { registerSubmissionRoute } from "./gateway/submission";
import { judgeModel } from "./judge-model";
import {
  createSubmissionsQueue,
  createSubmissionsWorker,
  enqueuePublish,
  enqueueValidation,
} from "./queues/submissions";
import { createTurnsQueue, createTurnsWorker, enqueueTurn } from "./queues/turns";
import { healTurnRunner, loadHealInputs } from "./heal-runner";
import { createFailuresQueue, createFailuresWorker, failureJobs } from "./queues/failures";
import {
  createMaintenanceQueue,
  createMaintenanceWorker,
  scheduleReconciler,
} from "./queues/maintenance";
import { reconcile } from "./queues/reconcile";
import { redeliverFailed } from "./queues/redeliver";
import { createWebhooksQueue, createWebhooksWorker } from "./queues/webhooks";
import { createRateLimitRedis, createRedis, pingRedis } from "./redis";
import { createShutdown } from "./shutdown";
import { ollamaClient } from "./ollama";
import { createRulesWorker } from "./queues/rules";
import { ruleModel } from "./rule-model";
import { triageModel } from "./triage-model";

async function main(): Promise<void> {
  const env = loadWorkerEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, service: "worker" });

  const db = createDb(env.DATABASE_URL);
  const redis = createRedis(env.REDIS_URL, logger);
  const pacing = redisPacing(redis, logger);
  const maintenanceQueue = createMaintenanceQueue(redis, logger);

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
  // The self-hosted model (D11). If Ollama is down, calls fail, are recorded, and jobs the
  // heuristics can't place stay unknown; triage itself goes on.
  const ollama = ollamaClient({ baseUrl: env.OLLAMA_URL });
  const triage = triageModel({ client: ollama, model: env.TRIAGE_MODEL, logger });
  const failuresQueue = createFailuresQueue(redis, logger);
  const jobs = failureJobs(failuresQueue);
  const failuresWorker = createFailuresWorker(redis, {
    db,
    githubApp,
    logger,
    pacing,
    jobs,
    triageModel: triage,
    dispatchEnabled: env.HEAL_DISPATCH,
  });
  // Custom rules (P3.9): compiled one at a time with HEAL_MODEL; admins confirm the result.
  const rulesWorker = createRulesWorker(redis, {
    db,
    logger,
    ruleModel: ruleModel({ client: ollama, model: env.HEAL_MODEL, logger }),
  });
  const webhooksQueue = createWebhooksQueue(redis, logger);
  const webhooksWorker = createWebhooksWorker(redis, {
    db,
    githubApp,
    logger,
    failureJobs: jobs,
    pacing,
  });

  const rateLimitRedis = createRateLimitRedis(env.REDIS_URL, logger);
  const gateway = await buildGateway({
    logger,
    rateLimit: { ...DEFAULT_RATE_LIMIT, redis: rateLimitRedis },
    trustedProxies: env.GATEWAY_TRUSTED_PROXIES,
  });
  registerSessionRoute(gateway, {
    sessions: runnerSessions(db, "gateway"),
    keys: githubOidcKeys(),
    appSlug: env.GITHUB_APP_SLUG,
    // The attempt's wall-clock budget comes from its repository's effective policy (SPEC §8).
    wallClockMinutes: async (attempt) => {
      const system = await forSystem(db, attempt.orgId, "gateway");
      const { policy } = effectivePolicy(await system.policies.layers(attempt.failure.repo.id));
      return policy.limits.maxWallClockMinutes;
    },
  });
  // The model turns of the step loop (D15): HEAL_MODEL on Ollama (D11, D17).
  const turnsQueue = createTurnsQueue(redis);
  const turnsWorker = createTurnsWorker(redis, {
    attempts: async (orgId) => (await forSystem(db, orgId, "turns")).attempts,
    runner: healTurnRunner({
      client: ollama,
      model: env.HEAL_MODEL,
      load: (orgId, attemptId) => loadHealInputs(db, orgId, attemptId),
      logger,
    }),
    logger,
  });
  registerStepRoutes(gateway, {
    sessions: runnerSessions(db, "gateway"),
    attempts: async (orgId) => (await forSystem(db, orgId, "gateway")).attempts,
    maxIterations: async (session) => {
      const system = await forSystem(db, session.orgId, "gateway");
      const { policy } = effectivePolicy(await system.policies.layers(session.repoId));
      return policy.limits.maxIterationsPerAttempt;
    },
    enqueueTurn: (job) => enqueueTurn(turnsQueue, job),
  });
  // Submissions (P5.1): stored by the gateway, then checked by the `submissions` worker.
  const submissionsQueue = createSubmissionsQueue(redis);
  const submissionsWorker = createSubmissionsWorker(redis, {
    db,
    githubApp,
    judge: judgeModel({ client: ollama, model: env.HEAL_MODEL, logger }),
    enqueuePublish: (job) => enqueuePublish(submissionsQueue, job),
    model: env.HEAL_MODEL,
    logger,
  });
  registerSubmissionRoute(gateway, {
    sessions: runnerSessions(db, "gateway"),
    attempts: async (orgId) => (await forSystem(db, orgId, "gateway")).attempts,
    enqueueValidation: (job) => enqueueValidation(submissionsQueue, job),
  });
  // The §2.2 reconciler: timeouts, lost jobs and missed webhooks, then failed deliveries.
  const maintenanceWorker = createMaintenanceWorker(redis, logger, undefined, async () => {
    await reconcile({ db, githubApp, pacing, submissions: submissionsQueue, logger });
    await redeliverFailed({ db, githubApp, logger });
  });
  const internal = buildInternalServer({ logger, checks: { redis: () => pingRedis(redis) } });

  const shutdown = createShutdown({
    logger,
    steps: [
      { name: "gateway", close: () => gateway.close() },
      { name: "internal server", close: () => internal.close() },
      { name: "webhooks worker", close: () => webhooksWorker.close() },
      { name: "webhooks queue", close: () => webhooksQueue.close() },
      { name: "failures worker", close: () => failuresWorker.close() },
      { name: "failures queue", close: () => failuresQueue.close() },
      { name: "rules worker", close: () => rulesWorker.close() },
      { name: "turns worker", close: () => turnsWorker.close() },
      { name: "turns queue", close: () => turnsQueue.close() },
      { name: "submissions worker", close: () => submissionsWorker.close() },
      { name: "submissions queue", close: () => submissionsQueue.close() },
      { name: "maintenance worker", close: () => maintenanceWorker.close() },
      { name: "maintenance queue", close: () => maintenanceQueue.close() },
      { name: "redis", close: () => redis.quit() },
      { name: "rate-limit redis", close: () => rateLimitRedis.quit() },
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
  await internal.listen({ host: env.GATEWAY_INTERNAL_HOST, port: env.GATEWAY_INTERNAL_PORT });
  await maintenanceQueue.add("ping", { requestedAt: new Date().toISOString() });
  await scheduleReconciler(maintenanceQueue);
  if (githubApp === null) logger.warn("GitHub App not configured: webhook repo sync is disabled");
  // Host only: the URL is internal infrastructure.
  const ollamaHost = new URL(env.OLLAMA_URL).host;
  ollama.hasModel(env.TRIAGE_MODEL).then(
    (pulled) => {
      if (!pulled) {
        logger.warn({ model: env.TRIAGE_MODEL, ollamaHost }, "TRIAGE_MODEL isn't pulled on Ollama");
      }
    },
    (error: unknown) => {
      logger.warn({ ollamaHost, err: error }, "Ollama unreachable: unclear jobs will stay unknown");
    },
  );
  logger.info("worker started");
}

main().catch((error: unknown) => {
  // Before the logger exists (e.g. invalid env), write the message only: no stack, no values.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`worker failed to start: ${message}\n`);
  process.exit(1);
});
