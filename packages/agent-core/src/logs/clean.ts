// SPEC §6.2 step 2: a raw GitHub Actions job log, cleaned for redaction, the error window and the
// model. Pure: no I/O.

/** Longer lines (minified bundles, base64 blobs) are cut: they cost tokens and help nobody. */
export const MAX_LINE_LENGTH = 2_000;

// GitHub prefixes every log line with an ISO 8601 timestamp (7 fractional digits).
const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/gm;
// Built from character codes: control characters written literally in source are invisible,
// and linters rightly reject them in regex literals.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const BOM = String.fromCharCode(0xfeff);
// CSI sequences (colors, cursor moves: ESC [ ... final byte) and OSC sequences (hyperlinks,
// titles: ESC ] ... terminated by BEL or ESC \), then any other two-character escape.
// In these template strings `\\[` and `\\]` reach the regex as `\[` and `\]` (literal brackets),
// and `\\\\` as `\\` (a literal backslash, the end of ESC \).
const OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g");
const CSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
const OTHER_ESCAPE = new RegExp(`${ESC}[@-_]`, "g");

function capLine(line: string): string {
  if (line.length <= MAX_LINE_LENGTH) return line;
  const cut = line.length - MAX_LINE_LENGTH;
  return `${line.slice(0, MAX_LINE_LENGTH)}… [${String(cut)} more characters]`;
}

/** Keeps what a terminal would show last: text after the final carriage return. */
function lastProgressState(line: string): string {
  const trimmed = line.replace(/\r+$/, "");
  const cr = trimmed.lastIndexOf("\r");
  return cr === -1 ? trimmed : trimmed.slice(cr + 1);
}

export function cleanLog(raw: string): string {
  const text = raw
    .replace(new RegExp(`^${BOM}`), "")
    .replace(/\r\n/g, "\n")
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(OTHER_ESCAPE, "")
    .replace(TIMESTAMP_PREFIX, "");
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (line === "##[endgroup]") continue;
    const shown = lastProgressState(line);
    lines.push(capLine(shown.startsWith("##[group]") ? shown.slice("##[group]".length) : shown));
  }
  return lines.join("\n");
}
