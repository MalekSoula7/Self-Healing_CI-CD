// Comments PipeHeal posts on its own pull requests (SPEC §9.1). Pure. Names from the repository
// are shown literally, with the PR body's rules (./body.ts).
import { githubLink, inlineCode } from "./body";

export interface FailedCiJob {
  workflowName: string;
  /** Null when the run failed without a failed job (e.g. it couldn't start). */
  jobName: string | null;
  failedStep: string | null;
  runUrl: string | null;
}

const MAX_JOBS = 10;

/** When CI never answered (§2.2). `reason` is PipeHeal's own words. */
export function unverifiedComment(reason: string): string {
  return [
    `PipeHeal couldn't verify this fix: ${reason}.`,
    "",
    "Nothing shows that it works, so review it with extra care. PipeHeal never merges.",
  ].join("\n");
}

export function ciFailedComment(commitSha: string, jobs: readonly FailedCiJob[]): string {
  const lines = jobs.slice(0, MAX_JOBS).map((job) => {
    const where = [
      job.workflowName,
      job.jobName ?? "(no failed job)",
      ...(job.failedStep === null ? [] : [job.failedStep]),
    ]
      .map((part) => inlineCode(part, 100))
      .join(" / ");
    const link = githubLink("failed run", job.runUrl);
    return `- ${where}${link === null ? "" : ` · ${link}`}`;
  });
  const more = jobs.length - MAX_JOBS;
  return [
    `PipeHeal's fix didn't pass CI on \`${commitSha.slice(0, 12)}\`.`,
    "",
    ...lines,
    ...(more > 0 ? [`- …and ${String(more)} more`] : []),
    "",
    "Someone needs to take it from here. PipeHeal never merges.",
  ].join("\n");
}
