// Triage of a failure once its collection window has closed (SPEC §2 step 5, §6.2 steps 1-6):
// download each failed job's log, then (agent-core's triageLog) take the failed step, clean and
// redact it, and store its error window and signals; classify the job (heuristics first,
// TRIAGE_MODEL when they can't tell), then the failure from its jobs. Only redacted text ever
// reaches the database, the model or the logs.
import {
  CATEGORIES,
  classifyHeuristically,
  combineClassifications,
  triageLog,
  type Classification,
} from "@pipeheal/agent-core";
import { forSystem, type Db } from "@pipeheal/db";
import { GitHubApiError, type GitHubApp, type JobLog, type RepoClient } from "@pipeheal/github";
import type { Logger } from "@pipeheal/shared/logger";
import type { TriageModel } from "../triage-model";

export interface FailureTarget {
  orgId: string;
  failureId: string;
  installationId: bigint;
}

export interface TriageDeps {
  db: Db;
  githubApp: GitHubApp | null;
  /** Null without ANTHROPIC_API_KEY (development): what heuristics can't classify stays unknown. */
  triageModel: TriageModel | null;
}

function unknown(summary: string): Classification {
  return { category: "unknown", confidence: 0, summary, suspectedFiles: [] };
}

/** A stored job's classification, for the failure's (files aren't stored per job). */
function storedClassification(job: {
  category: string | null;
  confidence: number | null;
  summary: string | null;
}): Classification | null {
  const category = CATEGORIES.find((c) => c.toUpperCase() === job.category);
  if (category === undefined || job.confidence === null || job.summary === null) return null;
  return { category, confidence: job.confidence, summary: job.summary, suspectedFiles: [] };
}

/** The job's log, or null when GitHub no longer has it (logs expire; a job can be deleted). */
async function fetchLog(repoClient: RepoClient, githubJobId: bigint): Promise<JobLog | null> {
  try {
    return await repoClient.downloadJobLog(githubJobId);
  } catch (error) {
    if (error instanceof GitHubApiError && (error.status === 404 || error.status === 410)) {
      return null;
    }
    throw error;
  }
}

/** Triages every failed job of the failure not triaged yet. Safe to repeat. */
export async function triageFailure(
  deps: TriageDeps,
  target: FailureTarget,
  log: Logger,
): Promise<void> {
  const system = await forSystem(deps.db, target.orgId, "triage");
  const failure = await system.failures.get(target.failureId);
  if (failure === null) return;
  const pending = failure.runs.flatMap((run) => run.jobs.filter((job) => job.errorWindow === null));
  if (pending.length === 0) return;
  const repo = await system.repositories.get(failure.repoId);
  if (repo === null) return;
  if (deps.githubApp === null) {
    log.warn("GitHub App isn't configured; skipping triage");
    return;
  }
  const repoClient = (await deps.githubApp.installation(target.installationId)).repo(repo.fullName);

  const runOf = new Map(failure.runs.flatMap((run) => run.jobs.map((job) => [job.id, run])));
  for (const job of pending) {
    const run = runOf.get(job.id);
    const conclusion = run?.conclusion === "timed_out" ? "timed_out" : "failure";
    const fetched = await fetchLog(repoClient, job.githubJobId);
    if (fetched === null) {
      // GitHub no longer has the log: an empty window marks the job as triaged.
      const classification =
        conclusion === "timed_out"
          ? { category: "infra" as const, confidence: 0.9, summary: "The job timed out." }
          : unknown("GitHub no longer has this job's log.");
      await system.failures.recordJobTriage(job.id, {
        errorWindow: "",
        classification: pickStored(classification),
      });
      log.info({ failedJobId: job.id }, "job log unavailable");
      continue;
    }
    const { window, signals, redactions } = triageLog(fetched.text, {
      failedStep: job.failedStep,
    });
    let source = "heuristic";
    let classification = classifyHeuristically({ window, signals, conclusion });
    if (classification === null && deps.triageModel !== null) {
      source = "model";
      classification = await deps.triageModel.classify(
        { window, signals, workflowName: run?.workflowName ?? "unknown", jobName: job.name },
        async (call) => {
          await system.failures.recordModelCall(failure.id, call);
        },
      );
    }
    if (classification === null) {
      source = "none";
      classification = unknown("Couldn't tell why this job failed from its log.");
    }
    await system.failures.recordJobTriage(job.id, {
      errorWindow: window,
      signals,
      redactions,
      classification: pickStored(classification),
    });
    log.info(
      {
        failedJobId: job.id,
        truncated: fetched.truncated,
        lines: window.split("\n").length,
        tools: signals.tools,
        errorCodes: signals.errorCodes,
        redactions,
        category: classification.category,
        confidence: classification.confidence,
        source,
      },
      "job log triaged",
    );
  }

  // The failure's classification, from every job still failing (a run that passed on a re-run
  // no longer counts), including jobs triaged earlier (late arrivals).
  const updated = await system.failures.get(target.failureId);
  const jobs = (updated?.runs ?? [])
    .filter((run) => run.conclusion !== "success")
    .flatMap((run) =>
      run.jobs.flatMap((job) => {
        const classification = storedClassification(job);
        return classification === null ? [] : [{ jobName: job.name, classification }];
      }),
    );
  if (jobs.length === 0) return;
  const combined = combineClassifications(jobs);
  await system.failures.recordTriage(failure.id, pickStored(combined));
  log.info({ category: combined.category, confidence: combined.confidence }, "failure triaged");
}

/** What's stored of a classification (files aren't, yet). */
function pickStored(classification: Omit<Classification, "suspectedFiles">) {
  const { category, confidence, summary } = classification;
  return { category, confidence, summary };
}
