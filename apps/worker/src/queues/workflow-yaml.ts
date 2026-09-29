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
