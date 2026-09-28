// Processes GitHub webhook deliveries `apps/web` enqueued (SPEC §2 step 4, §5.1, §10). Only
// `installation` and `installation_repositories` are handled here; `workflow_run` and
// `pull_request` (subscribed to per SPEC §5.1) get their processors in Phase 2.
import {
  SYNC_BATCH_LIMIT,
  forSystem,
  installations,
  markWebhookDeliveryFailed,
  markWebhookDeliveryProcessed,
  type Db,
} from "@pipeheal/db";
import {
  installationEventSchema,
  installationRepositoriesEventSchema,
  toAccountType,
  type GitHubApp,
  type InstallationEvent,
  type InstallationRepositoriesEvent,
  type RepoClient,
  type Workflow,
} from "@pipeheal/github";
import { redactText, webhookJobDataSchema, WEBHOOKS_QUEUE } from "@pipeheal/shared";
import type { Logger } from "@pipeheal/shared/logger";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { isCiLooking, parseWorkflowYaml, type WorkflowFacts } from "./workflow-yaml";

export interface WebhookProcessorDeps {
  db: Db;
  /** Null when the GitHub App isn't configured yet: repository/workflow sync is skipped. */
  githubApp: GitHubApp | null;
  logger: Logger;
}

interface QueueJob {
  id?: string | undefined;
  data: unknown;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

/**
 * Fetches the installation's current repositories from GitHub (authoritative: the webhook's own
 * repo lists lack `defaultBranch`), upserts them, then discovers each one's workflows. Used for
 * `installation.created` and `installation_repositories.added`.
 */
async function syncRepositoriesAndWorkflows(
  deps: WebhookProcessorDeps,
  orgId: string,
  installationId: bigint,
  log: Logger,
): Promise<void> {
  if (deps.githubApp === null) {
    log.warn("GitHub App isn't configured; skipping repository sync");
    return;
  }
  const system = await forSystem(deps.db, orgId, "webhook");
  const client = await deps.githubApp.installation(installationId);
  const repositories = (await client.listRepositories()).filter((repo) => !repo.archived);

  const synced = [];
  for (const batch of chunk(repositories, SYNC_BATCH_LIMIT)) {
    synced.push(
      ...(await system.repositories.syncInstalled(
        batch.map(({ githubRepoId, fullName, defaultBranch }) => ({
          githubRepoId,
          fullName,
          defaultBranch,
        })),
      )),
    );
  }

  for (const repo of synced) {
    const repoClient = client.repo(repo.fullName);
    const workflows = await repoClient.listWorkflows();
    const facts = await workflowFacts(repoClient, repo.defaultBranch, workflows, log);
    await system.workflows.syncInstalled(
      repo.id,
      workflows.map((workflow) => {
        const known = facts.get(workflow.id);
        return {
          githubWorkflowId: workflow.id,
          path: workflow.path,
          name: workflow.name,
          ...known,
          // Only meaningful the moment a workflow is first discovered (syncInstalled ignores it
          // afterward); omitted when facts couldn't be determined, so a brand-new workflow just
          // starts unselected like any other unknown.
          ...(known === undefined
            ? {}
            : { selected: isCiLooking({ ...known, name: workflow.name, path: workflow.path }) }),
        };
      }),
    );
  }
}

/**
 * Each workflow's triggers and `environment:` use (SPEC §11's pre-selection heuristic, §6.2
 * step 8's re-run guard), read from the file at the repo's default branch. Missing from the
 * result for any workflow whose content couldn't be fetched or didn't parse: the caller then
 * keeps whatever facts it already had, rather than overwriting them with empty defaults.
 */
async function workflowFacts(
  repoClient: RepoClient,
  defaultBranch: string,
  workflows: readonly Workflow[],
  log: Logger,
): Promise<Map<bigint, WorkflowFacts>> {
  const facts = new Map<bigint, WorkflowFacts>();
  const headSha = await repoClient.getBranchSha(defaultBranch);
  if (headSha === null) {
    log.warn({ defaultBranch }, "default branch not found; keeping known workflow facts");
    return facts;
  }
  for (const workflow of workflows) {
    const file = await repoClient.getFileAtRef(workflow.path, headSha);
    const parsed = file?.kind === "text" ? parseWorkflowYaml(file.content) : null;
    if (parsed !== null) facts.set(workflow.id, parsed);
  }
  return facts;
}

async function removeAllRepositories(
  deps: WebhookProcessorDeps,
  orgId: string,
  log: Logger,
): Promise<void> {
  const system = await forSystem(deps.db, orgId, "webhook");
  const active = await system.repositories.list();
  if (active.length === 0) return;
  for (const batch of chunk(
    active.map((repo) => repo.githubRepoId),
    SYNC_BATCH_LIMIT,
  )) {
    await system.repositories.markRemoved(batch);
  }
  log.info({ count: active.length }, "marked repositories removed on uninstall");
}

async function processInstallationEvent(
  deps: WebhookProcessorDeps,
  event: InstallationEvent,
  log: Logger,
): Promise<void> {
  const installs = installations(deps.db, "webhook");
  switch (event.action) {
    case "created": {
      const org = await installs.upsert({
        githubAccountId: event.installation.account.id,
        login: event.installation.account.login,
        accountType: toAccountType(event.installation.account.type),
        installationId: event.installation.id,
        // Only `created` names an OWNER candidate (P1.3 follow-up): other actions must not.
        installerGithubId: event.sender.id,
      });
      await syncRepositoriesAndWorkflows(deps, org.id, event.installation.id, log);
      return;
    }
    case "deleted": {
      const org = await installs.setStatus(event.installation.id, "UNINSTALLED");
      if (org !== null) await removeAllRepositories(deps, org.id, log);
      return;
    }
    case "suspend":
      await installs.setStatus(event.installation.id, "SUSPENDED");
      return;
    case "unsuspend":
      await installs.setStatus(event.installation.id, "ACTIVE");
      return;
    default:
      // e.g. new_permissions_accepted: nothing to do yet.
      log.info({ action: event.action }, "installation action has no processor yet");
  }
}

async function processInstallationRepositoriesEvent(
  deps: WebhookProcessorDeps,
  event: InstallationRepositoriesEvent,
  log: Logger,
): Promise<void> {
  const installs = installations(deps.db, "webhook");
  const org = await installs.findByInstallationId(event.installation.id);
  if (org === null) {
    log.warn("installation_repositories for an unknown installation; ignoring");
    return;
  }
  if (event.action === "added" && event.repositories_added.length > 0) {
    await syncRepositoriesAndWorkflows(deps, org.id, event.installation.id, log);
    return;
  }
  if (event.action === "removed" && event.repositories_removed.length > 0) {
    const system = await forSystem(deps.db, org.id, "webhook");
    for (const batch of chunk(
      event.repositories_removed.map((repo) => repo.id),
      SYNC_BATCH_LIMIT,
    )) {
      await system.repositories.markRemoved(batch);
    }
  }
}

/**
 * Processes one webhook delivery. Marks it processed on success; on failure records a redacted
 * error and rethrows, so BullMQ retries with its configured backoff.
 */
export async function processWebhookJob(job: QueueJob, deps: WebhookProcessorDeps): Promise<void> {
  const { deliveryId, event, payload } = webhookJobDataSchema.parse(job.data);
  const log = deps.logger.child({ deliveryId, event, jobId: job.id });
  try {
    switch (event) {
      case "installation":
        await processInstallationEvent(deps, installationEventSchema.parse(payload), log);
        break;
      case "installation_repositories":
        await processInstallationRepositoriesEvent(
          deps,
          installationRepositoriesEventSchema.parse(payload),
          log,
        );
        break;
      default:
        // ping, workflow_run, pull_request, or anything GitHub adds later: no processor yet
        // (Phase 2+). Acknowledged, not an error.
        log.info("no processor for this event yet; acknowledged");
    }
    await markWebhookDeliveryProcessed(deps.db, deliveryId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markWebhookDeliveryFailed(deps.db, deliveryId, redactText(message));
    throw error;
  }
}

export type WebhooksQueue = Queue<unknown, void>;

// `prefix` isolates keys (tests use a unique one); production uses BullMQ's default.
export function createWebhooksQueue(
  connection: Redis,
  logger: Logger,
  prefix?: string,
): WebhooksQueue {
  const queue: WebhooksQueue = new Queue(WEBHOOKS_QUEUE, {
    connection,
    prefix,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });
  queue.on("error", (error) => {
    logger.error({ error: error.message }, "webhooks queue error");
  });
  return queue;
}

export function createWebhooksWorker(
  connection: Redis,
  deps: Omit<WebhookProcessorDeps, "logger"> & { logger: Logger },
  prefix?: string,
): Worker {
  const worker = new Worker(WEBHOOKS_QUEUE, (job: QueueJob) => processWebhookJob(job, deps), {
    connection,
    prefix,
    concurrency: 5,
  });
  worker.on("failed", (job, error) => {
    deps.logger.error(
      { jobId: job?.id, event: job?.name, error: error.message },
      "webhook job failed",
    );
  });
  worker.on("error", (error) => {
    deps.logger.error({ error: error.message }, "webhooks worker error");
  });
  return worker;
}
