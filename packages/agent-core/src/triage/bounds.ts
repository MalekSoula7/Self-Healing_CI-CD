// Logs are untrusted and unbounded: whatever a step prints, what triage hands on must fit where it
// goes (the database, a prompt). These limits mirror packages/db's jobSignalsSchema and
// jobTriageInputSchema (a worker test checks the two agree on adversarial logs); the window's is
// lower than the column's so a window also fits in a model prompt (SPEC §6.2).
import type { Diagnostic, Location, Signals } from "./signals";

export const TRIAGE_LIMITS = {
  /** Characters of error window (300 lines of up to 2,000 characters could be 600,000). */
  windowChars: 60_000,
  failedStep: 255,
  message: 600,
  code: 100,
  path: 500,
  testId: 1_000,
  errorCode: 100,
} as const;

/** Characters kept from the window's start when it's cut (the command and first failure). */
const WINDOW_HEAD = 20_000;

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A line, column or exit code as the database can store it, or undefined. */
function storable(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) ? value : undefined;
}

function boundDiagnostic(diagnostic: Diagnostic): Diagnostic {
  const { code, path, line, column, ...rest } = diagnostic;
  const safeLine = storable(line);
  const safeColumn = storable(column);
  return {
    ...rest,
    message: cut(diagnostic.message, TRIAGE_LIMITS.message),
    ...(code === undefined ? {} : { code: cut(code, TRIAGE_LIMITS.code) }),
    ...(path === undefined ? {} : { path: cut(path, TRIAGE_LIMITS.path) }),
    ...(safeLine === undefined || safeLine < 0 ? {} : { line: safeLine }),
    ...(safeColumn === undefined || safeColumn < 0 ? {} : { column: safeColumn }),
  };
}

function boundLocation(location: Location): Location[] {
  const line = storable(location.line);
  if (line === undefined || line < 0) return [];
  const column = storable(location.column);
  return [
    {
      path: cut(location.path, TRIAGE_LIMITS.path),
      line,
      ...(column === undefined || column < 0 ? {} : { column }),
    },
  ];
}

export function boundSignals(signals: Signals): Signals {
  return {
    ...signals,
    failedStep:
      signals.failedStep === null ? null : cut(signals.failedStep, TRIAGE_LIMITS.failedStep),
    exitCode: storable(signals.exitCode ?? undefined) ?? null,
    diagnostics: signals.diagnostics.map(boundDiagnostic),
    failingTests: signals.failingTests.map((id) => cut(id, TRIAGE_LIMITS.testId)),
    locations: signals.locations.flatMap(boundLocation),
    errorCodes: signals.errorCodes.map((code) => cut(code, TRIAGE_LIMITS.errorCode)),
  };
}

/**
 * The window within TRIAGE_LIMITS.windowChars: its start (the command, the first failure) and
 * its end (the last failure, the exit), cut at line boundaries, with what was left out counted.
 */
export function boundWindow(window: string): string {
  if (window.length <= TRIAGE_LIMITS.windowChars) return window;
  const headEnd = window.lastIndexOf("\n", WINDOW_HEAD);
  const head = window.slice(0, headEnd === -1 ? WINDOW_HEAD : headEnd);
  // Room for the marker line, at its longest.
  const tailBudget = TRIAGE_LIMITS.windowChars - head.length - 60;
  const tailStart = window.indexOf("\n", window.length - tailBudget);
  const tail = window.slice(tailStart === -1 ? window.length - tailBudget : tailStart + 1);
  const omitted = window.length - head.length - tail.length;
  return `${head}\n… ${String(omitted)} characters omitted …\n${tail}`;
}
