// SPEC §6.2 step 5: signals from a failed step's (cleaned, redacted) output: what failed, where,
// with which codes, and the exit code. Parsers for tsc, ESLint, Vitest, Jest, pytest, mypy, ruff,
// npm and pip, written against real logs (fixtures/logs/). Pure.

export type Tool =
  "tsc" | "eslint" | "vitest" | "jest" | "pytest" | "mypy" | "ruff" | "npm" | "pip";

export interface Location {
  /** Repo-relative POSIX path. */
  path: string;
  line: number;
  column?: number;
}

export interface Diagnostic {
  tool: Tool;
  severity: "error" | "warning";
  message: string;
  /** TS2305, I001, attr-defined, an ESLint rule, an npm error code, a Python exception type. */
  code?: string;
  path?: string;
  line?: number;
  column?: number;
}

export interface Signals {
  failedStep: string | null;
  exitCode: number | null;
  /** Tools whose output was recognized, in the order they appear. */
  tools: Tool[];
  diagnostics: Diagnostic[];
  /** Test IDs as the runner prints them (`file > suite > test`, `file::test`). */
  failingTests: string[];
  /** Every file:line the output points at, diagnostics and test failures alike. */
  locations: Location[];
  errorCodes: string[];
}

/** Each list keeps at most this many items: enough to triage, bounded for storage and prompts. */
export const MAX_SIGNAL_ITEMS = 50;
const MAX_MESSAGE_LENGTH = 500;

/** Runner checkouts (Linux, Windows, container) and `./` become repo-relative POSIX paths. */
export function repoPath(raw: string): string {
  return raw
    .replace(/\\/g, "/")
    .replace(/^\/home\/runner\/work\/[^/]+\/[^/]+\//, "")
    .replace(/^[A-Za-z]:\/a\/[^/]+\/[^/]+\//, "")
    .replace(/^\/github\/workspace\//, "")
    .replace(/^\.\//, "");
}

const EXIT = /^##\[error\]Process completed with exit code (\d+)\.$/;
const ANNOTATION = /^##\[(?:error|warning)\]/;

const TSC_PAREN =
  /^(?<path>[^\s()][^()]*?)\((?<line>\d+),(?<column>\d+)\): (?<severity>error|warning) (?<code>TS\d+): (?<message>.+)$/;
const TSC_PRETTY =
  /^(?<path>\S+?):(?<line>\d+):(?<column>\d+) - (?<severity>error|warning) (?<code>TS\d+): (?<message>.+)$/;
const TSC_BARE = /^(?<severity>error) (?<code>TS\d+): (?<message>.+)$/;
const MYPY =
  /^(?<path>[^\s:]+\.pyi?):(?<line>\d+):(?:(?<column>\d+):)? (?<severity>error|warning): (?<message>.+?)(?: {2}\[(?<code>[a-z][a-z0-9-]*)\])?$/;
const RUFF_CONCISE =
  /^(?<path>[^\s:]+):(?<line>\d+):(?<column>\d+): (?<code>[A-Z]{1,4}\d{1,4}) (?:\[\*\] )?(?<message>.+)$/;
const RUFF_HEADER = /^(?<code>[A-Z]{1,4}\d{2,4}) (?:\[\*\] )?(?<message>\S.*)$/;
const RUFF_ARROW = /^\s*--> (?<path>\S+?):(?<line>\d+):(?<column>\d+)$/;
const ESLINT_FILE = /^(?:[A-Za-z]:)?[\w@./\\-]+\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/;
const ESLINT_ROW =
  /^\s+(?<line>\d+):(?<column>\d+)\s+(?<severity>error|warning)\s+(?<message>.+?)(?:\s{2,}(?<code>[@\w][\w@/.-]*))?$/;
const VITEST_FAIL = /^\s*FAIL\s+(?<file>\S+?\.[cm]?[jt]sx?)(?: > (?<name>.+?))?(?: \[ .+ \])?\s*$/;
const VITEST_LOCATION = /^\s*❯ (?<path>[^\s:]+):(?<line>\d+):(?<column>\d+)\s*$/;
const JEST_FAIL = /^FAIL (?<file>\S+?)(?: \([\d.]+ m?s\))?$/;
const JEST_TEST = /^\s+● (?<name>.+)$/;
const STACK_LOCATION = /^\s+at .*\((?<path>[^()]+?):(?<line>\d+):(?<column>\d+)\)$/;
const PYTEST_SESSION = /^=+ test session starts =+$/;
const PYTEST_SUMMARY = /^(?<kind>FAILED|ERROR) (?<id>\S+)(?: - (?<message>.+))?$/;
const PYTEST_LOCATION = /^(?<path>[^\s:]+\.py):(?<line>\d+): (?<code>\w+)$/;
const PYTHON_EXCEPTION = /^(?<code>\w*(?:Error|Exception|Exit|Interrupt))\b/;
const NPM_CODE = /^npm (?:error|ERR!) code (?<code>\S+)$/;
const NPM_LINE = /^npm (?:error|ERR!)\s?(?<text>.*)$/;
const PIP_ERROR = /^ERROR: (?<message>.+)$/;
// What a failed test's message looks like; runners print other lines in between (Vitest's info).
const TEST_MESSAGE = /^(?:\w*(?:Error|Exception)\b|expect\(|thrown:)/;
const TEST_MESSAGE_LOOKAHEAD = 6;

function truncate(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > MAX_MESSAGE_LENGTH ? `${trimmed.slice(0, MAX_MESSAGE_LENGTH)}…` : trimmed;
}

function location(path: string, line: string, column?: string): Location {
  return {
    path: repoPath(path),
    line: Number(line),
    ...(column === undefined ? {} : { column: Number(column) }),
  };
}

class Collector {
  private readonly tools: Tool[] = [];
  private readonly diagnostics: Diagnostic[] = [];
  private readonly diagnosticKeys = new Set<string>();
  private readonly failingTests: string[] = [];
  private readonly locations: Location[] = [];
  private readonly locationKeys = new Set<string>();

  tool(tool: Tool): void {
    if (!this.tools.includes(tool)) this.tools.push(tool);
  }

  diagnostic(
    tool: Tool,
    fields: Omit<Diagnostic, "tool" | "severity" | "message"> & {
      severity?: string | undefined;
      message: string;
    },
  ): void {
    this.tool(tool);
    const diagnostic: Diagnostic = {
      tool,
      severity: fields.severity === "warning" ? "warning" : "error",
      message: truncate(fields.message),
      ...(fields.code === undefined ? {} : { code: fields.code }),
      ...(fields.path === undefined ? {} : { path: repoPath(fields.path) }),
      ...(fields.line === undefined ? {} : { line: fields.line }),
      ...(fields.column === undefined ? {} : { column: fields.column }),
    };
    const key = JSON.stringify(diagnostic);
    if (this.diagnosticKeys.has(key) || this.diagnostics.length >= MAX_SIGNAL_ITEMS) return;
    this.diagnosticKeys.add(key);
    this.diagnostics.push(diagnostic);
    if (diagnostic.path !== undefined && diagnostic.line !== undefined) {
      this.location({
        path: diagnostic.path,
        line: diagnostic.line,
        ...(diagnostic.column === undefined ? {} : { column: diagnostic.column }),
      });
    }
  }

  failingTest(tool: Tool, id: string): void {
    this.tool(tool);
    if (!this.failingTests.includes(id) && this.failingTests.length < MAX_SIGNAL_ITEMS) {
      this.failingTests.push(id);
    }
  }

  location(found: Location): void {
    const key = `${found.path}:${String(found.line)}:${String(found.column)}`;
    if (this.locationKeys.has(key) || this.locations.length >= MAX_SIGNAL_ITEMS) return;
    this.locationKeys.add(key);
    this.locations.push(found);
  }

  result(failedStep: string | null, exitCode: number | null): Signals {
    const errorCodes: string[] = [];
    for (const { code } of this.diagnostics) {
      if (code !== undefined && !errorCodes.includes(code)) errorCodes.push(code);
    }
    return {
      failedStep,
      exitCode,
      tools: this.tools,
      diagnostics: this.diagnostics,
      failingTests: this.failingTests,
      locations: this.locations,
      errorCodes,
    };
  }
}

const num = (value: string | undefined) => (value === undefined ? undefined : Number(value));

export function extractSignals(text: string, failedStep: string | null = null): Signals {
  const found = new Collector();
  let exitCode: number | null = null;
  let eslintFile: string | undefined;
  let ruffPending: { code: string; message: string } | undefined;
  let jestFile: string | undefined;
  // A failed test whose message (the next error-looking line) we're waiting for.
  let awaitingMessage: { tool: "vitest" | "jest"; linesLeft: number } | undefined;
  let npm: { code: string; texts: string[] } | undefined;

  const finishNpm = () => {
    if (npm === undefined) return;
    found.diagnostic("npm", { code: npm.code, message: npm.texts.join(" ") || npm.code });
    npm = undefined;
  };

  for (const rawLine of text.split("\n")) {
    const exit = EXIT.exec(rawLine);
    if (exit !== null) {
      exitCode = Number(exit[1]);
      continue;
    }
    // Problem matchers (setup-node's tsc and ESLint matchers) annotate tool lines in place.
    const line = rawLine.replace(ANNOTATION, "");

    if (npm !== undefined) {
      const npmLine = NPM_LINE.exec(line);
      const npmText = npmLine?.groups?.text?.trim();
      if (npmText === undefined || /^Usage:|^A complete log of this run/.test(npmText)) {
        finishNpm();
      } else {
        if (npmText !== "" && npm.texts.length < 2) npm.texts.push(npmText);
        continue;
      }
    }

    if (ruffPending !== undefined) {
      const arrow = RUFF_ARROW.exec(line)?.groups;
      if (arrow?.path !== undefined && arrow.line !== undefined) {
        found.diagnostic("ruff", {
          ...ruffPending,
          path: arrow.path,
          line: Number(arrow.line),
          column: num(arrow.column),
        });
      }
      if (line.trim() !== "" || arrow !== undefined) ruffPending = undefined;
      if (arrow !== undefined) continue;
    }

    if (awaitingMessage !== undefined && line.trim() !== "") {
      if (TEST_MESSAGE.test(line.trim())) {
        found.diagnostic(awaitingMessage.tool, { message: line.trim() });
        awaitingMessage = undefined;
        continue;
      }
      if (--awaitingMessage.linesLeft === 0) awaitingMessage = undefined;
    }

    let groups = (TSC_PAREN.exec(line) ?? TSC_PRETTY.exec(line))?.groups;
    if (groups?.path !== undefined && groups.line !== undefined && groups.message !== undefined) {
      found.diagnostic("tsc", {
        code: groups.code,
        severity: groups.severity,
        message: groups.message,
        path: groups.path,
        line: Number(groups.line),
        column: num(groups.column),
      });
      continue;
    }
    groups = TSC_BARE.exec(line)?.groups;
    if (groups?.message !== undefined) {
      found.diagnostic("tsc", { code: groups.code, message: groups.message });
      continue;
    }

    groups = MYPY.exec(line)?.groups;
    if (groups?.path !== undefined && groups.line !== undefined && groups.message !== undefined) {
      found.diagnostic("mypy", {
        code: groups.code,
        severity: groups.severity,
        message: groups.message,
        path: groups.path,
        line: Number(groups.line),
        column: num(groups.column),
      });
      continue;
    }

    groups = RUFF_CONCISE.exec(line)?.groups;
    if (groups?.path !== undefined && groups.line !== undefined && groups.message !== undefined) {
      found.diagnostic("ruff", {
        code: groups.code,
        message: groups.message,
        path: groups.path,
        line: Number(groups.line),
        column: num(groups.column),
      });
      continue;
    }
    groups = RUFF_HEADER.exec(line)?.groups;
    if (groups?.code !== undefined && groups.message !== undefined) {
      // Only ruff when the next line points at a file (" --> path:line:col").
      ruffPending = { code: groups.code, message: groups.message };
      continue;
    }

    if (ESLINT_FILE.test(line)) {
      eslintFile = line;
      continue;
    }
    groups = ESLINT_ROW.exec(line)?.groups;
    if (groups?.line !== undefined && groups.message !== undefined && eslintFile !== undefined) {
      found.diagnostic("eslint", {
        code: groups.code,
        severity: groups.severity,
        message: groups.message,
        path: eslintFile,
        line: Number(groups.line),
        column: num(groups.column),
      });
      continue;
    }

    groups = VITEST_FAIL.exec(line)?.groups;
    if (groups?.file !== undefined) {
      found.failingTest(
        "vitest",
        groups.name === undefined ? groups.file : `${groups.file} > ${groups.name}`,
      );
      awaitingMessage = { tool: "vitest", linesLeft: TEST_MESSAGE_LOOKAHEAD };
      continue;
    }
    groups = VITEST_LOCATION.exec(line)?.groups;
    if (groups?.path !== undefined && groups.line !== undefined) {
      found.location(location(groups.path, groups.line, groups.column));
      continue;
    }

    groups = JEST_FAIL.exec(line)?.groups;
    if (groups?.file !== undefined) {
      jestFile = groups.file;
      found.tool("jest");
      continue;
    }
    groups = JEST_TEST.exec(line)?.groups;
    if (groups?.name !== undefined && jestFile !== undefined) {
      found.failingTest("jest", `${jestFile} > ${groups.name}`);
      awaitingMessage = { tool: "jest", linesLeft: TEST_MESSAGE_LOOKAHEAD };
      continue;
    }
    groups = STACK_LOCATION.exec(line)?.groups;
    if (
      groups?.path !== undefined &&
      groups.line !== undefined &&
      jestFile !== undefined &&
      !/node_modules|^node:/.test(groups.path)
    ) {
      found.location(location(groups.path, groups.line, groups.column));
      continue;
    }

    if (PYTEST_SESSION.test(line)) {
      found.tool("pytest");
      continue;
    }
    groups = PIP_ERROR.exec(line)?.groups;
    if (groups?.message !== undefined) {
      if (!groups.message.startsWith("Ignored the following")) {
        found.diagnostic("pip", { message: groups.message });
      }
      continue;
    }
    groups = PYTEST_SUMMARY.exec(line)?.groups;
    if (groups?.id !== undefined) {
      found.failingTest("pytest", groups.id);
      if (groups.message !== undefined) {
        found.diagnostic("pytest", {
          code: PYTHON_EXCEPTION.exec(groups.message)?.groups?.code,
          message: groups.message,
        });
      }
      continue;
    }
    groups = PYTEST_LOCATION.exec(line)?.groups;
    if (groups?.path !== undefined && groups.line !== undefined) {
      found.location(location(groups.path, groups.line));
      continue;
    }

    groups = NPM_CODE.exec(line)?.groups;
    if (groups?.code !== undefined) {
      finishNpm();
      npm = { code: groups.code, texts: [] };
    }
  }
  finishNpm();
  return found.result(failedStep, exitCode);
}
