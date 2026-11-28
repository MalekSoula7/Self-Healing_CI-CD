// Triage of one failed job's log (SPEC §6.2 steps 2-5): the failed step, cleaned and redacted,
// its error window, and its signals. Pure.
import { capLongLines, cleanLog } from "../logs/clean";
import { redactLog, type RedactionKind } from "../redact/redact";
import { boundSignals, boundWindow } from "./bounds";
import { extractSignals, type Signals } from "./signals";
import { failedStepLog } from "./step";
import { extractErrorWindow } from "./window";

export { TRIAGE_LIMITS, boundSignals, boundWindow } from "./bounds";
export { MAX_SIGNAL_ITEMS, extractSignals, repoPath } from "./signals";
export type { Diagnostic, Location, Signals, Tool } from "./signals";
export { failedStepLog } from "./step";
export { MAX_WINDOW_LINES, extractErrorWindow } from "./window";

export interface TriagedLog {
  /** Redacted. */
  window: string;
  /** Parsed from the redacted text: nothing in here was ever unredacted. */
  signals: Signals;
  redactions: Partial<Record<RedactionKind, number>>;
}

/**
 * Raw job log → the failed step → cleaned → redacted → error window and signals, each bounded to
 * what can be stored and prompted (TRIAGE_LIMITS).
 */
export function triageLog(raw: string, options: { failedStep?: string | null } = {}): TriagedLog {
  // Redacted before long lines are cut: a cut can split a secret below what the rules recognize.
  const redacted = redactLog(cleanLog(failedStepLog(raw), { capLines: false }));
  const text = capLongLines(redacted.text);
  const { redactions } = redacted;
  return {
    window: boundWindow(extractErrorWindow(text)),
    signals: boundSignals(extractSignals(text, options.failedStep ?? null)),
    redactions,
  };
}
