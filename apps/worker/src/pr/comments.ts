// Comments PipeHeal posts on its own pull requests (SPEC §9.1). Pure. Names from the repository
// are shown literally, with the PR body's rules (./body.ts).
import { codeBlock, githubLink, inlineCode } from "./body";

export interface FailedCiJob {
  workflowName: string;
  /** Null when the run failed without a failed job (e.g. it couldn't start). */
  jobName: string | null;
  failedStep: string | null;
  runUrl: string | null;
}

const MAX_JOBS = 10;

/**
 * A retry's commit on the same pull request (P5.3d), whose description still tells of the first
 * fix. Paths and the model's words are shown literally.
 */
export function retryPushedComment(
  commitSha: string,
  files: readonly string[],
  rootCause: string | null,
  draftReasons: readonly string[],
): string {
  const more = files.length - MAX_JOBS;
  return [
    `PipeHeal pushed a second fix in \`${commitSha.slice(0, 12)}\`. CI checks it now.`,
    "",
    ...files.slice(0, MAX_JOBS).map((path) => `- ${inlineCode(path, 300)}`),
    ...(more > 0 ? [`- …and ${String(more)} more`] : []),
    ...(rootCause === null ? [] : ["", "The model's account:", codeBlock(rootCause, 1_000)]),
    ...(draftReasons.length === 0
      ? []
      : ["", "Review with extra care:", ...draftReasons.map((r) => `- ${inlineCode(r, 300)}`)]),
    "",
    "The checks and limits cover both fixes together. PipeHeal never merges.",
  ].join("\n");
}

/** When CI never answered (§2.2). `reason` is PipeHeal's own words. */
export function unverifiedComment(reason: string): string {
  return [
    `PipeHeal couldn't verify this fix: ${reason}.`,
    "",
    "Nothing shows that it works, so review it with extra care. PipeHeal never merges.",
  ].join("\n");
}

export function ciFailedComment(
  commitSha: string,
  jobs: readonly FailedCiJob[],
  /** A second attempt started (§9.1). */
  retrying = false,
): string {
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
    retrying
      ? "PipeHeal is trying once more, and may push a second commit to this branch. If none appears, someone needs to take it from here. PipeHeal never merges."
      : "Someone needs to take it from here. PipeHeal never merges.",
  ].join("\n");
}
