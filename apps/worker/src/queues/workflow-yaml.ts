// Parses a workflow file's YAML for what SPEC §11's "CI-looking" pre-selection and SPEC §6.2
// step 8's `usesEnvironment` guard need. Untrusted repository content (CLAUDE.md): malformed or
// unrecognizable YAML never throws, callers get null and keep the workflow's stored defaults.
import { parse } from "yaml";

export interface WorkflowFacts {
  /** Trigger event names from `on:` (push, pull_request, workflow_dispatch, ...). */
  triggers: string[];
  /** Any job declares `environment:` (never re-run or dispatched by us, SPEC §6.2). */
  usesEnvironment: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function triggersOf(on: unknown): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.filter((item): item is string => typeof item === "string");
  if (isRecord(on)) return Object.keys(on);
  return [];
}

function jobUsesEnvironment(job: unknown): boolean {
  return isRecord(job) && "environment" in job;
}

/** Facts about a workflow file's content, or null when it isn't a parseable workflow. */
export function parseWorkflowYaml(content: string): WorkflowFacts | null {
  let doc: unknown;
  try {
    doc = parse(content);
  } catch {
    return null;
  }
  if (!isRecord(doc)) return null;
  const jobs = isRecord(doc.jobs) ? Object.values(doc.jobs) : [];
  return { triggers: triggersOf(doc.on), usesEnvironment: jobs.some(jobUsesEnvironment) };
}

const DEPLOY_LIKE = /deploy|release|publish/i;

/**
 * SPEC §11's onboarding pre-selection: triggered by push or pull_request, no job uses
 * `environment:`, and neither the name nor path suggests a deploy/release/publish workflow
 * (those mostly fail for reasons we don't heal, and a re-run of one can deploy again).
 */
export function isCiLooking(workflow: WorkflowFacts & { name: string; path: string }): boolean {
  return (
    (workflow.triggers.includes("push") || workflow.triggers.includes("pull_request")) &&
    !workflow.usesEnvironment &&
    !DEPLOY_LIKE.test(workflow.name) &&
    !DEPLOY_LIKE.test(workflow.path)
  );
}

/**
 * Why re-running this workflow's failed jobs could deploy, or null (SPEC §6.2 step 8's guard).
 * `rerun-failed-jobs` also re-runs every job that depends on a failed one, so the whole workflow
 * counts, not only the failed job:
 * - a job declares `environment:`;
 * - a job calls a reusable workflow (`uses:` at job level): what it runs isn't in this file;
 * - a job's ID or name says deploy, release or publish.
 * Unparseable YAML is a risk too: nothing can be checked.
 */
export function rerunRisk(content: string): string | null {
  let doc: unknown;
  try {
    doc = parse(content);
  } catch {
    return "the workflow file doesn't parse";
  }
  if (!isRecord(doc) || !isRecord(doc.jobs)) return "the workflow file has no jobs";
  for (const [id, job] of Object.entries(doc.jobs)) {
    if (!isRecord(job)) continue;
    if ("environment" in job) return `job ${id} uses an environment`;
    if ("uses" in job) return `job ${id} calls a reusable workflow`;
    const name = typeof job.name === "string" ? job.name : "";
    if (DEPLOY_LIKE.test(id) || DEPLOY_LIKE.test(name)) return `job ${id} looks like a deploy`;
  }
  return null;
}
