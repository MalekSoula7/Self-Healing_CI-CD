// SPEC §6.2 step 4: the error window of a failed step's (cleaned, redacted) output. Pure.

/** The hard cap on the window, in lines. */
export const MAX_WINDOW_LINES = 300;

const CONTEXT_BEFORE = 3;
const CONTEXT_AFTER = 12;
const TAIL = 40;

// Lines that report a failure: SPEC §6.2's list, plus the tools' own error formats.
const ANCHORS: readonly RegExp[] = [
  /^##\[error\]/,
  /\bFAIL\b/,
  /^FAILED /,
  /\bError:/,
  /^Traceback \(most recent call last\):/,
  /\berror TS\d+/,
  /^E {3}/,
  /: error: /,
  /^\s+\d+:\d+\s+error\s/,
  /^[A-Z]{1,4}\d{2,4} /,
  /^npm (?:error|ERR!) code /,
  /^ERROR[: ]/,
  /^\s*● /,
];

function isAnchor(line: string): boolean {
  return ANCHORS.some((pattern) => pattern.test(line));
}

/** Lines the window would show for these indices: the lines, plus one marker per gap. */
function renderedSize(indices: ReadonlySet<number>): number {
  let gaps = 0;
  let previous: number | undefined;
  for (const index of [...indices].sort((a, b) => a - b)) {
    if (previous !== undefined && index - previous > 1) gaps++;
    previous = index;
  }
  return indices.size + gaps;
}

/**
 * The whole step when it fits in MAX_WINDOW_LINES. Otherwise its first line (the command), the
 * lines around each failure report in order while they fit, and its last lines, with a marker
 * where lines were left out.
 */
export function extractErrorWindow(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= MAX_WINDOW_LINES) return text;

  const kept = new Set<number>([0]);
  for (let i = lines.length - TAIL; i < lines.length; i++) kept.add(i);
  // Stops at the first anchor that no longer fits. Every anchor tried either adds lines or was
  // already kept, so this ends within a few hundred anchors however long the step is.
  for (const [index, line] of lines.entries()) {
    if (!isAnchor(line)) continue;
    const candidate = new Set(kept);
    const from = Math.max(0, index - CONTEXT_BEFORE);
    const to = Math.min(lines.length - 1, index + CONTEXT_AFTER);
    for (let i = from; i <= to; i++) candidate.add(i);
    if (renderedSize(candidate) > MAX_WINDOW_LINES) break;
    for (const i of candidate) kept.add(i);
  }

  const out: string[] = [];
  let previous = -1;
  for (const [index, line] of lines.entries()) {
    if (!kept.has(index)) continue;
    if (index - previous > 1) out.push(`… ${String(index - previous - 1)} lines omitted …`);
    out.push(line);
    previous = index;
  }
  return out.join("\n");
}
