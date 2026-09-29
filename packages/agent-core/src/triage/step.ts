// The failed step's own lines, from a raw GitHub Actions job log (SPEC §6.2 step 4: "the tail of
// the failed step"). Works on the raw log because it needs GitHub's step markers, which cleanLog
// removes. Pure: no I/O.

const BOM = String.fromCharCode(0xfeff);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;

/** A line's content, without GitHub's timestamp. */
function content(line: string): string {
  return line.replace(BOM, "").replace(TIMESTAMP, "");
}

/**
 * The failed step: its command ("Run npm test"), then its output after the header GitHub prints
 * (the command echo, `shell:`, `env:`), through the step's final `##[error]` line. Post-job steps
 * that follow in the job log are left out. Without a `##[error]` line, the whole log; without a
 * step header before it, everything up to it.
 */
export function failedStepLog(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const text = lines.map(content);
  const error = text.findLastIndex((line) => line.startsWith("##[error]"));
  if (error === -1) return raw;
  let start = -1;
  let command = "";
  for (const [index, line] of text.entries()) {
    if (index >= error) break;
    if (line.startsWith("##[group]Run ")) {
      start = index;
      command = line.slice("##[group]".length);
    }
  }
  if (start === -1) return lines.slice(0, error + 1).join("\n");
  const headerEnd = text.findIndex(
    (line, index) => index > start && index < error && line === "##[endgroup]",
  );
  const output = lines.slice(headerEnd === -1 ? start + 1 : headerEnd + 1, error + 1);
  return [command, ...output].join("\n");
}
