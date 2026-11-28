// What CI says about PipeHeal's commit (SPEC §9.1, P5.3a, D22). Pure. The caller passes only the
// runs that count: watched workflows, this repository's own code, on PipeHeal's branch.

export interface CiRun {
  id: bigint;
  workflowId: bigint;
  status: string | null;
  conclusion: string | null;
  event: string;
}

/**
 * Triggers whose success can prove a fix: the repository's own CI of the commit. A run someone
 * started by hand (or on a schedule) can skip what matters, so only its failure counts.
 */
export const PROOF_EVENTS: ReadonlySet<string> = new Set(["push", "pull_request"]);

export type CiVerdict<Run extends CiRun = CiRun> =
  | { kind: "green" }
  | { kind: "red"; failed: Run[] }
  /**
   * No answer yet. Waiting for a run to start, for the running ones to finish, or (all finished,
   * nothing failed) for proof: a successful run of each workflow that failed originally.
   */
  | { kind: "pending"; waitingFor: "start" | "finish" | "proof" };

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

export function isProof(run: CiRun): boolean {
  return run.conclusion === "success" && PROOF_EVENTS.has(run.event);
}

export function ciVerdict<Run extends CiRun>(
  runs: readonly Run[],
  /** The workflows that failed on the healed commit: each must succeed for a green verdict. */
  required: ReadonlySet<bigint>,
): CiVerdict<Run> {
  if (runs.length === 0) return { kind: "pending", waitingFor: "start" };
  if (runs.some((run) => run.status !== "completed")) {
    return { kind: "pending", waitingFor: "finish" };
  }
  const failed = runs.filter((run) => run.conclusion !== null && FAILED.has(run.conclusion));
  if (failed.length > 0) return { kind: "red", failed };
  const passed = new Set(runs.filter(isProof).map((run) => run.workflowId));
  // A skipped or absent check proves nothing about the fix.
  const proven = required.size > 0 && [...required].every((id) => passed.has(id));
  return proven ? { kind: "green" } : { kind: "pending", waitingFor: "proof" };
}

export interface FailedOriginally {
  workflowId: bigint;
  name: string;
  failedStep: string | null;
}

export interface RanAgain {
  workflowId: bigint;
  name: string;
  conclusion: string | null;
  succeededSteps: readonly string[];
}

/**
 * Whether every job that failed originally ran again and succeeded, its failed step included. A
 * run can succeed with that job or step skipped (an `if:` on the branch or event).
 */
export function jobsProven(failed: readonly FailedOriginally[], ran: readonly RanAgain[]): boolean {
  return failed.every((job) =>
    ran.some(
      (again) =>
        again.workflowId === job.workflowId &&
        again.name === job.name &&
        again.conclusion === "success" &&
        (job.failedStep === null || again.succeededSteps.includes(job.failedStep)),
    ),
  );
}
