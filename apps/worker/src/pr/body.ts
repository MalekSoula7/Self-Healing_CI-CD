// The pull request PipeHeal opens (SPEC §9, P5.2b): its title, its body and whether it is a draft.
// Pure. Most of what the body shows was written by someone PipeHeal doesn't trust: the model (its
// account of the fix), the repository (paths, workflow and job names) and CI (test IDs, check
// names). All of it is shown literally, inside code spans or fenced blocks, which GitHub renders as
// text: no HTML, no links or images, no @mentions or #references (P4.7 review M4, P5.1 review L5).
// Control, bidi and zero-width characters are dropped first, so nothing can hide or reorder text.
// The only links are PipeHeal's own: GitHub run pages and the dashboard.
import type { FixSummary, SubmissionValidation } from "@pipeheal/db";

export interface PrBodyInput {
  failure: {
    headSha: string;
    /** As stored: SPEC §6.1's category in upper case. */
    category: string | null;
    jobs: {
      workflowName: string;
      jobName: string;
      failedStep: string | null;
      runUrl: string | null;
    }[];
  };
  fix: FixSummary | null;
  /** The changed paths, as validated. */
  files: string[];
  failingCheck: string;
  validation: SubmissionValidation;
  /** Test counts after the fix and in the baseline, when behavioral checks ran. */
  tests: { after: number; baseline: number } | null;
  attempt: { attemptNo: number; iterations: number; model: string; timelineUrl: string | null };
}

/** GitHub refuses bodies past 65,536 characters; this leaves room for later edits. */
export const MAX_BODY_CHARS = 60_000;
const MAX_TITLE_SUMMARY = 72;
const MAX_JOBS_SHOWN = 5;
const MAX_FILES_SHOWN = 50;

/** Bidi controls, zero-width characters and the BOM: they can hide or reorder text. */
const HIDDEN = new Set([
  0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060,
  0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
]);

/** Drops control characters (a tab becomes a space, a newline stays) and hidden ones. */
function clean(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x09) out += " ";
    else if (code === 0x0a) out += "\n";
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || HIDDEN.has(code)) continue;
    else out += char;
  }
  return out;
}

function capped(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

/** Untrusted text on one line, as a code span its content can't close. */
export function inlineCode(text: string, max = 200): string {
  const line = capped(clean(text).replace(/\s+/g, " ").trim(), max) || "(empty)";
  const run = longestBacktickRun(line);
  return run === 0 ? `\`${line}\`` : `${"`".repeat(run + 1)} ${line} ${"`".repeat(run + 1)}`;
}

/** Untrusted text as a fenced block, with a fence longer than any backtick run inside. */
export function codeBlock(text: string, max = 2_000): string {
  const body = capped(clean(text).trim(), max) || "(empty)";
  const fence = "`".repeat(Math.max(3, longestBacktickRun(body) + 1));
  return `${fence}text\n${body}\n${fence}`;
}

/** A short name shown as is when it is a plain identifier (`test`, `CR-2`), as code otherwise. */
function name(text: string): string {
  return /^[A-Za-z0-9_-]{1,40}$/.test(text) ? text : inlineCode(text, 40);
}

/** A link only to GitHub's own pages, or nothing. */
function githubLink(label: string, url: string | null): string | null {
  return url !== null && /^https:\/\/github\.com\/[^\s()<>]+$/.test(url)
    ? `[${label}](${url})`
    : null;
}

/** `fix: <first sentence of the root cause> [PipeHeal]`, one plain line. */
export function prTitle(fix: FixSummary | null): string {
  const text = clean(fix?.rootCause ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return "fix: repair the failing CI check [PipeHeal]";
  const sentence = /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
  // Titles render references and mentions too: break them up.
  const summary = capped(sentence, MAX_TITLE_SUMMARY)
    .replace(/@(?=[\w-])/g, "@\u200B")
    .replace(/#(?=\d)/g, "#\u200B");
  return `fix: ${summary} [PipeHeal]`;
}

const RANK = { low: 0, medium: 1, high: 2 } as const;

/**
 * A draft when the model's confidence is at or below the policy's threshold (SPEC §8.3
 * `review.draftBelowConfidence`), when validation named a reason (behavioral checks unavailable,
 * file-wide suppressions), or when the model gave no confidence at all.
 */
export function isDraft(
  fix: FixSummary | null,
  validation: SubmissionValidation,
  threshold: "low" | "medium" | "never",
): boolean {
  if (validation.draftReasons.length > 0 || !validation.behavior.available) return true;
  if (fix === null) return true;
  if (threshold === "never") return false;
  return RANK[fix.confidence] <= RANK[threshold];
}

function whatFailed(input: PrBodyInput): string[] {
  const sha = /^[0-9a-f]{40}$/.test(input.failure.headSha)
    ? `\`${input.failure.headSha.slice(0, 12)}\``
    : inlineCode(input.failure.headSha, 40);
  const category = (input.failure.category ?? "unknown").toLowerCase().replace(/[^a-z]/g, "");
  const lines = input.failure.jobs.slice(0, MAX_JOBS_SHOWN).map((job) => {
    const where = [job.workflowName, job.jobName, job.failedStep ?? "(no step)"]
      .map((part) => inlineCode(part, 100))
      .join(" / ");
    const link = githubLink("failed run", job.runUrl);
    return `${where} on ${sha}${link === null ? "" : ` · ${link}`} · category: ${category}`;
  });
  const more = input.failure.jobs.length - MAX_JOBS_SHOWN;
  if (more > 0) lines.push(`…and ${String(more)} more failed jobs`);
  return lines.length > 0 ? lines : [`On ${sha} · category: ${category}`];
}

function verification(input: PrBodyInput): string[] {
  const { validation } = input;
  const checks = validation.checks
    .map((check) => `${name(check.name)} ${check.exitCode === 0 ? "✅" : "❌"}`)
    .join(" ");
  const tests =
    input.tests === null
      ? ""
      : ` (${String(input.tests.after)} tests, baseline ${String(input.tests.baseline)})`;
  const behavior = validation.behavior.available
    ? `passed${tests}`
    : `unavailable (${inlineCode(validation.behavior.reason ?? "no baseline", 200)})`;
  return [
    `- Reproduced failure: yes (${inlineCode(input.failingCheck, 20)})`,
    `- After fix: ${checks === "" ? "no checks reported" : checks}`,
    `- Behavioral checks: ${behavior}`,
  ];
}

function rulesChecked(validation: SubmissionValidation): string {
  const judge = validation.judge.map(
    (verdict) => `${verdict.outcome === "passed" ? "✅" : "❌"} ${name(verdict.ruleId)} (AI judge)`,
  );
  return ["✅ PipeHeal's invariants", "✅ the repository's policy", ...judge].join(" · ");
}

export function prBody(input: PrBodyInput): string {
  const { fix, validation, attempt } = input;
  const files = input.files.slice(0, MAX_FILES_SHOWN).map((path) => `- ${inlineCode(path, 300)}`);
  if (input.files.length > MAX_FILES_SHOWN) {
    files.push(`- …and ${String(input.files.length - MAX_FILES_SHOWN)} more`);
  }
  const drafted = validation.draftReasons.length > 0 || !validation.behavior.available;
  const timeline =
    attempt.timelineUrl !== null && /^https:\/\/[^\s()<>]+$/.test(attempt.timelineUrl)
      ? ` · [Full timeline](${attempt.timelineUrl})`
      : "";
  const sections = [
    "## What failed",
    ...whatFailed(input),
    "",
    "## Root cause",
    fix === null ? "The model gave no account of its fix." : codeBlock(fix.rootCause),
    "",
    "## What changed",
    ...files,
    ...(fix === null ? [] : ["", codeBlock(fix.changes)]),
    "",
    "## Verification",
    ...verification(input),
    ...(fix === null ? [] : ["", "The model's own account:", codeBlock(fix.verification, 1_000)]),
    "",
    "## Rules checked",
    rulesChecked(validation),
    ...(drafted
      ? [
          "",
          "## Opened as a draft",
          ...validation.draftReasons.map((reason) => `- ${inlineCode(reason, 300)}`),
          ...(validation.behavior.available
            ? []
            : ["- Behavioral checks were unavailable: no baseline test report to compare with."]),
        ]
      : []),
    "",
    "## Attempt",
    `Iterations: ${String(attempt.iterations)} · Model: ${inlineCode(attempt.model, 100)} · Attempt ${String(attempt.attemptNo)}${timeline}`,
    "",
    "> AI-generated change. Review it like any other PR. PipeHeal never merges.",
  ];
  return capped(sections.join("\n"), MAX_BODY_CHARS);
}
