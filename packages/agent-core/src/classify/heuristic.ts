// SPEC §6.2 step 6, heuristics first: a failed job's category from its signals and error window,
// when the evidence is unambiguous (a tool's error code, a missing secret, a lost runner). Null
// when nothing matches: the model decides then. Pure.
import type { Diagnostic, Signals } from "../triage";

export const CATEGORIES = [
  "compile",
  "typecheck",
  "lint",
  "test",
  "dependency",
  "build",
  "infra",
  "config",
  "flaky",
  "unknown",
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Classification {
  category: Category;
  /** 0..1 */
  confidence: number;
  /** From redacted text only. */
  summary: string;
  suspectedFiles: string[];
}

export interface HeuristicInput {
  window: string;
  signals: Signals;
  conclusion: "failure" | "timed_out";
}

/** When categories compete: what blocks a fix most comes first. */
export const CATEGORY_PRIORITY: readonly Category[] = [
  "config",
  "dependency",
  "infra",
  "compile",
  "typecheck",
  "lint",
  "build",
  "test",
  "flaky",
  "unknown",
];

const MAX_SUSPECTED_FILES = 10;

// A missing secret, variable or permission: nothing in the code to fix (SPEC §6.1 `config`).
const CONFIG = [
  /missing required environment variable/i,
  /environment variable [\w-]+ (?:is )?(?:not set|missing|undefined)/i,
  /secret [\w-]+ (?:is )?not (?:set|found)/i,
  /Input required and not supplied/,
  /Resource not accessible by integration/,
  /\bBad credentials\b/,
  /Authentication failed for/,
  /Permission denied \(publickey\)/,
];
// The runner or machine failed, not the code.
const HARD_INFRA = [
  /runner has received a shutdown signal/i,
  /lost communication with the server/i,
  /JavaScript heap out of memory/,
  /exit code 137\b/,
  /No space left on device/,
  /exceeded the maximum execution time/i,
];
// Network trouble: weaker, a test can legitimately fail on it too.
const NETWORK = [
  /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND)\b/,
  /Could not resolve host/,
  /socket hang up/,
  /503 Service Unavailable/,
  /API rate limit exceeded/,
];
const BUILD = [
  /error during build/i,
  /\bBuild failed\b/i,
  /Rollup failed/,
  /webpack .*compiled with \d+ errors?/i,
  /Module not found: Error: Can't resolve/,
];

const NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ENOSPC"]);
const TSC_COMPILE = new Set(["TS2304", "TS2552", "TS2503", "TS2582"]);
const RUFF_COMPILE = new Set(["F821", "F822", "F823", "E999"]);

/** `'zod'` is a package; `'./cart'` is a file in the repository. */
function missingPackage(message: string): boolean | null {
  const match =
    /(?:Cannot find (?:module|package)|No module named|Failed to load url) '?"?([^'"\s]+)/.exec(
      message,
    );
  if (match?.[1] === undefined) return null;
  return !/^[./]/.test(match[1]);
}

function categoryOf(diagnostic: Diagnostic): Category {
  const { tool, code = "", message } = diagnostic;
  switch (tool) {
    case "tsc":
      if (code === "TS2307") return missingPackage(message) === true ? "dependency" : "compile";
      return code.startsWith("TS1") || TSC_COMPILE.has(code) ? "compile" : "typecheck";
    case "mypy":
      if (code === "import-not-found" || code === "import-untyped") return "dependency";
      return code === "name-defined" || code === "syntax" ? "compile" : "typecheck";
    case "ruff":
      return RUFF_COMPILE.has(code) ? "compile" : "lint";
    case "eslint":
      return message.startsWith("Parsing error") ? "compile" : "lint";
    case "npm":
      return NETWORK_CODES.has(code) ? "infra" : "dependency";
    case "pip":
      return "dependency";
    default:
      // Test runners: a missing package or a syntax error stops the tests before they run.
      if (missingPackage(message) === true) return "dependency";
      return /\bSyntaxError\b/.test(message) ? "compile" : "test";
  }
}

function describe(diagnostic: Diagnostic): string {
  const where =
    diagnostic.path === undefined
      ? ""
      : ` (${diagnostic.path}${diagnostic.line === undefined ? "" : `:${String(diagnostic.line)}`})`;
  const code = diagnostic.code === undefined ? "" : ` ${diagnostic.code}`;
  return `${diagnostic.tool}${code}: ${diagnostic.message}${where}`;
}

function suspectedFiles(signals: Signals): string[] {
  const files: string[] = [];
  for (const { path } of signals.locations) {
    if (!files.includes(path) && !path.includes("node_modules/")) files.push(path);
  }
  return files.slice(0, MAX_SUSPECTED_FILES);
}

/** The first line of the window matching one of the patterns. */
function matchingLine(window: string, patterns: readonly RegExp[]): string | null {
  for (const line of window.split("\n")) {
    if (patterns.some((pattern) => pattern.test(line))) return line.trim();
  }
  return null;
}

function testSummary(signals: Signals, diagnostics: readonly Diagnostic[]): string {
  const count = signals.failingTests.length;
  const [first] = signals.failingTests;
  const message = diagnostics[0]?.message;
  if (first === undefined)
    return describe(
      diagnostics[0] ?? { tool: "pytest", severity: "error", message: "tests failed" },
    );
  const example = message === undefined ? first : `${first}: ${message}`;
  return `${String(count)} failing test${count === 1 ? "" : "s"}, e.g. ${example}`;
}

export function classifyHeuristically(input: HeuristicInput): Classification | null {
  const { window, signals, conclusion } = input;
  const files = suspectedFiles(signals);
  const found = (category: Category, confidence: number, summary: string): Classification => ({
    category,
    confidence,
    summary: summary.slice(0, 1_000),
    suspectedFiles: files,
  });

  if (conclusion === "timed_out") return found("infra", 0.9, "The job timed out.");
  const config = matchingLine(window, CONFIG);
  if (config !== null) return found("config", 0.9, config);
  const hardInfra = matchingLine(window, HARD_INFRA);
  if (hardInfra !== null) return found("infra", 0.9, hardInfra);

  const errors = signals.diagnostics.filter((d) => d.severity === "error");
  const byCategory = new Map<Category, Diagnostic[]>();
  for (const diagnostic of errors) {
    const category = categoryOf(diagnostic);
    byCategory.set(category, [...(byCategory.get(category) ?? []), diagnostic]);
  }
  const category = CATEGORY_PRIORITY.find((candidate) => byCategory.has(candidate));
  if (category === "test" || (category === undefined && signals.failingTests.length > 0)) {
    return found("test", 0.9, testSummary(signals, byCategory.get("test") ?? []));
  }
  if (category !== undefined) {
    const [first, ...rest] = byCategory.get(category) ?? [];
    if (first !== undefined) {
      const more = rest.length === 0 ? "" : `, and ${String(rest.length)} more`;
      return found(category, 0.95, `${describe(first)}${more}`);
    }
  }

  const build = matchingLine(window, BUILD);
  if (build !== null) return found("build", 0.85, build);
  const network = matchingLine(window, NETWORK);
  if (network !== null) return found("infra", 0.8, network);
  return null;
}
