// The recent changes behind a failure (SPEC §6.2 step 7): what changed between the last green
// commit and the failing one, cut to a token budget so it fits next to the error window in a
// prompt. Files the failure's signals name come first, with as much of their diff as fits; then
// other source files; lockfiles and build output last. Every diff and commit message is redacted
// before it is measured, stored or shown: repository content is untrusted and may hold secrets.
// Pure: the worker fetches the comparison from GitHub and passes it in.
import { redactLog, type RedactionKind } from "../redact/redact";
import type { Signals } from "../triage";

/** Default size of the recent changes in a prompt, in estimated tokens. */
export const DEFAULT_RECENT_CHANGES_BUDGET = 12_000;
/** Commits get at most this share of the budget; files get the rest. */
const COMMIT_SHARE = 0.2;
const MAX_SUBJECT_LENGTH = 200;
/** Characters per token, on the low side so estimates err high (code tokenizes densely). */
const CHARS_PER_TOKEN = 3.5;

/** One changed file of a comparison (`@pipeheal/github`'s `Comparison` has this shape). */
export interface ChangedFileInput {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  /** Absent for binary files and diffs GitHub won't show. */
  patch: string | null;
}

export interface ComparisonInput {
  totalCommits: number;
  /** GitHub listed fewer commits than `totalCommits`. */
  commitsTruncated: boolean;
  /** GitHub stops listing files at 300. */
  filesTruncated: boolean;
  commits: { sha: string; message: string; authorLogin: string | null }[];
  files: ChangedFileInput[];
}

export interface RecentChangesOptions {
  /** Repo-relative paths the failure's signals name (`signalPaths`). */
  priorityPaths?: readonly string[];
  tokenBudget?: number;
}

/** full: the whole diff; partial: its first hunks; omitted: no room; none: no text diff. */
export type PatchState = "full" | "partial" | "omitted" | "none";

export interface RecentChangedFile {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  /** Named by the failure's signals. */
  priority: boolean;
  /** Redacted. Ends with an "omitted" line when partial. */
  patch: string | null;
  patchState: PatchState;
}

export interface RecentChanges {
  /** Commits between the base and the failing commit, as GitHub counts them. */
  totalCommits: number;
  commits: { sha: string; subject: string; authorLogin: string | null }[];
  omittedCommits: number;
  /** Files GitHub listed (at most 300). */
  totalFiles: number;
  files: RecentChangedFile[];
  /** Files GitHub listed but left out here for lack of room. */
  omittedFiles: number;
  /** GitHub's own lists were cut short: more commits or files changed than it showed. */
  githubTruncated: boolean;
  /** Of `renderRecentChanges(this)`; never above `tokenBudget`. */
  estimatedTokens: number;
  tokenBudget: number;
  redactions: Partial<Record<RedactionKind, number>>;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** A line's cost in a rendered text, its newline included. */
function lineCost(line: string): number {
  return Math.ceil((line.length + 1) / CHARS_PER_TOKEN);
}

function linesCost(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + lineCost(line), 0);
}

/** The file a test ID names: `file > suite > test` (Vitest), `file::test` (pytest). */
function testFile(id: string): string | null {
  const file = id.split(/ > |::/)[0]?.trim() ?? "";
  return /^[\w.\-/]+\.\w+$/.test(file) ? file : null;
}

/** What `signalPaths` reads of `Signals` (stored signals have the same shape). */
export interface SignalPathSources {
  locations: readonly Pick<Signals["locations"][number], "path">[];
  diagnostics: readonly { path?: string | undefined }[];
  failingTests: readonly string[];
}

/** The repo files a failure's signals point at, in order, once each. */
export function signalPaths(signals: SignalPathSources): string[] {
  const paths = [
    ...signals.locations.map((location) => location.path),
    ...signals.diagnostics.flatMap((diagnostic) =>
      diagnostic.path === undefined ? [] : [diagnostic.path],
    ),
    ...signals.failingTests.flatMap((id) => {
      const file = testFile(id);
      return file === null ? [] : [file];
    }),
  ];
  return [...new Set(paths)];
}

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "Cargo.lock",
  "go.sum",
  "composer.lock",
  "Gemfile.lock",
]);
const BUILD_OUTPUT = /(^|\/)(dist|build|vendor|node_modules)\/|\.min\.(js|css)$|\.map$/;

/** 0: named by the signals; 1: other files; 2: lockfiles and build output. */
function tier(file: ChangedFileInput, priority: ReadonlySet<string>): 0 | 1 | 2 {
  if (priority.has(file.path) || (file.previousPath !== null && priority.has(file.previousPath))) {
    return 0;
  }
  const name = file.path.slice(file.path.lastIndexOf("/") + 1);
  return LOCKFILES.has(name) || BUILD_OUTPUT.test(file.path) ? 2 : 1;
}

function addRedactions(
  total: Partial<Record<RedactionKind, number>>,
  more: Partial<Record<RedactionKind, number>>,
): void {
  for (const [kind, count] of Object.entries(more) as [RedactionKind, number][]) {
    total[kind] = (total[kind] ?? 0) + count;
  }
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? "" : "s"}`;
}

function commitLine(commit: RecentChanges["commits"][number]): string {
  const author = commit.authorLogin === null ? "" : ` (${commit.authorLogin})`;
  return `- ${commit.sha.slice(0, 7)} ${commit.subject}${author}`;
}

function moreCommitsLine(count: number): string {
  return `- … ${plural(count, "more commit")} not listed`;
}

function fileLine(file: Omit<RecentChangedFile, "patch">): string {
  const name = file.previousPath === null ? file.path : `${file.previousPath} -> ${file.path}`;
  const notes = [
    file.priority ? " [named in the failure]" : "",
    file.patchState === "none" ? " (no text diff)" : "",
    file.patchState === "omitted" ? " (diff omitted)" : "",
  ].join("");
  return `${file.status} ${name} (+${String(file.additions)} -${String(file.deletions)})${notes}`;
}

function moreFilesLine(count: number): string {
  return `… ${plural(count, "more changed file")} not listed`;
}

function omittedLinesLine(count: number): string {
  return `… ${plural(count, "more line")} of this diff omitted`;
}

/** The recent changes as text, for prompts and the UI. */
export function renderRecentChanges(changes: RecentChanges): string {
  const lines = [
    `Commits (${String(changes.commits.length)} of ${String(changes.totalCommits)}):`,
    ...changes.commits.map(commitLine),
    ...(changes.omittedCommits > 0 ? [moreCommitsLine(changes.omittedCommits)] : []),
    `Changed files (${String(changes.files.length)} of ${String(changes.totalFiles)}):`,
    ...changes.files.flatMap((file) => [
      fileLine(file),
      ...(file.patch === null ? [] : [file.patch]),
    ]),
    ...(changes.omittedFiles > 0 ? [moreFilesLine(changes.omittedFiles)] : []),
  ];
  return lines.join("\n");
}

/** Hunks of a unified diff, each starting at its `@@` line. */
function hunks(patch: string): string[][] {
  const result: string[][] = [];
  for (const line of patch.split("\n")) {
    const last = result.at(-1);
    if (line.startsWith("@@") || last === undefined) result.push([line]);
    else last.push(line);
  }
  return result;
}

/**
 * As much of `patch` as fits in `room` tokens: whole hunks in order, or when not even the first
 * fits, its first lines. Null when not even that fits.
 */
function partialPatch(patch: string, room: number): string | null {
  const all = patch.split("\n");
  // Room for the "N more lines omitted" note, at its longest.
  const available = room - lineCost(omittedLinesLine(all.length));
  const kept: string[] = [];
  let used = 0;
  for (const hunk of hunks(patch)) {
    const cost = linesCost(hunk);
    if (used + cost > available) break;
    kept.push(...hunk);
    used += cost;
  }
  if (kept.length === 0) {
    const leading: string[] = [];
    for (const line of all) {
      if (used + lineCost(line) > available) break;
      leading.push(line);
      used += lineCost(line);
    }
    // A hunk header alone says nothing.
    if (leading.length < 2) return null;
    kept.push(...leading);
  }
  return [...kept, omittedLinesLine(all.length - kept.length)].join("\n");
}

/** What changed since the last green commit, redacted and within the token budget. */
export function selectRecentChanges(
  comparison: ComparisonInput,
  options: RecentChangesOptions = {},
): RecentChanges {
  const tokenBudget = options.tokenBudget ?? DEFAULT_RECENT_CHANGES_BUDGET;
  const priority = new Set(options.priorityPaths ?? []);
  const redactions: Partial<Record<RedactionKind, number>> = {};
  const redact = (text: string): string => {
    const result = redactLog(text);
    addRedactions(redactions, result.redactions);
    return result.text;
  };
  const totalCommits = Math.max(comparison.totalCommits, comparison.commits.length);
  const totalFiles = comparison.files.length;

  // Headers, and the "more … not listed" lines at their longest, are always paid for.
  let used =
    lineCost(`Commits (${String(totalCommits)} of ${String(totalCommits)}):`) +
    lineCost(moreCommitsLine(totalCommits)) +
    lineCost(`Changed files (${String(totalFiles)} of ${String(totalFiles)}):`) +
    lineCost(moreFilesLine(totalFiles));

  // Commits, newest last as GitHub lists them, within their share.
  const commitRoom = Math.floor(tokenBudget * COMMIT_SHARE);
  const commits: RecentChanges["commits"] = [];
  let commitsUsed = 0;
  for (const commit of comparison.commits) {
    const newline = commit.message.indexOf("\n");
    const firstLine = (newline === -1 ? commit.message : commit.message.slice(0, newline)).trim();
    const entry = {
      sha: commit.sha,
      subject: redact(firstLine).slice(0, MAX_SUBJECT_LENGTH),
      authorLogin: commit.authorLogin,
    };
    const cost = lineCost(commitLine(entry));
    if (used + commitsUsed + cost > Math.min(tokenBudget, used + commitRoom)) break;
    commits.push(entry);
    commitsUsed += cost;
  }
  used += commitsUsed;

  const ordered = comparison.files
    .map((file, index) => ({ file, index, tier: tier(file, priority) }))
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        Number(a.file.patch === null) - Number(b.file.patch === null) ||
        a.file.additions + a.file.deletions - (b.file.additions + b.file.deletions) ||
        a.file.path.localeCompare(b.file.path) ||
        a.index - b.index,
    );

  // A file's line is paid for at its longest (with a note), so it never outgrows its cost.
  const metaCost = (file: ChangedFileInput, isPriority: boolean) =>
    lineCost(
      fileLine({ ...file, priority: isPriority, patchState: "omitted" }) + " (no text diff)",
    );

  const files: RecentChangedFile[] = [];
  const addPatch = (entry: RecentChangedFile, patch: string, allowPartial: boolean) => {
    const cost = lineCost(patch);
    if (used + cost <= tokenBudget) {
      entry.patch = patch;
      entry.patchState = "full";
      used += cost;
      return;
    }
    if (!allowPartial) return;
    const partial = partialPatch(patch, tokenBudget - used);
    if (partial === null) return;
    entry.patch = partial;
    entry.patchState = "partial";
    used += linesCost(partial.split("\n"));
  };
  const addFile = (file: ChangedFileInput, isPriority: boolean): RecentChangedFile | null => {
    const cost = metaCost(file, isPriority);
    if (used + cost > tokenBudget) return null;
    used += cost;
    const entry: RecentChangedFile = {
      path: file.path,
      previousPath: file.previousPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      priority: isPriority,
      patch: null,
      patchState: file.patch === null ? "none" : "omitted",
    };
    files.push(entry);
    return entry;
  };

  // Named files first, each with as much of its diff as fits.
  const rest: { file: ChangedFileInput; entry: RecentChangedFile }[] = [];
  for (const { file, tier: fileTier } of ordered) {
    if (fileTier !== 0) continue;
    const entry = addFile(file, true);
    if (entry !== null && file.patch !== null) addPatch(entry, redact(file.patch), true);
  }
  // Then every other file's name, while they fit; then their diffs, whole, in the same order.
  for (const { file, tier: fileTier } of ordered) {
    if (fileTier === 0) continue;
    const entry = addFile(file, false);
    if (entry !== null) rest.push({ file, entry });
  }
  for (const { file, entry } of rest) {
    if (file.patch !== null) addPatch(entry, redact(file.patch), false);
  }

  const changes: RecentChanges = {
    totalCommits,
    commits,
    omittedCommits: totalCommits - commits.length,
    totalFiles,
    files,
    omittedFiles: totalFiles - files.length,
    githubTruncated: comparison.commitsTruncated || comparison.filesTruncated,
    estimatedTokens: 0,
    tokenBudget,
    redactions,
  };
  changes.estimatedTokens = estimateTokens(renderRecentChanges(changes));
  return changes;
}
