// A pasted `git diff` into changes, for a dry run (SPEC §8.9, P3.10). A diff holds only the changed
// hunks, so each side is rebuilt from its hunks' lines: checks that read whole files (assertion
// counts, manifests) see only those lines. Real fixes are always checked on full contents (§8.5).
// Input is pasted text: bounded, paths validated, hunk counts checked; anything off is refused.
import { repoPathProblem } from "@pipeheal/shared/repo-path";
import type { ChangeInput, FileMode, FileState } from "./diff";

export const MAX_DIFF_CHARS = 512_000;
export const MAX_DIFF_FILES = 500;

export type DiffRead = { ok: true; changes: ChangeInput[] } | { ok: false; error: string };

class DiffError extends Error {}

/** Git's C-style quoted path (`"a/c art.ts"`), or the path as written. */
function unquote(path: string): string {
  const quoted = /^"(.*)"$/.exec(path);
  if (quoted === null) return path;
  return (quoted[1] ?? "").replace(/\\(["\\tn])/g, (_, char: string) =>
    char === "t" ? "\t" : char === "n" ? "\n" : char,
  );
}

/** `a/x` or `b/x` without its prefix; null for /dev/null. */
function sidePath(raw: string): string | null {
  const path = unquote(raw.trim());
  if (path === "/dev/null") return null;
  const stripped = /^[ab]\//.test(path) ? path.slice(2) : path;
  const problem = repoPathProblem(stripped);
  if (problem !== null) throw new DiffError(`${stripped}: ${problem}`);
  return stripped;
}

function headerPaths(line: string): [string, string] {
  const quoted = /^diff --git ("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(line);
  const plain = /^diff --git (a\/.+) (b\/.+)$/.exec(line);
  const match = quoted ?? plain;
  const a = match === null ? null : sidePath(match[1] ?? "");
  const b = match === null ? null : sidePath(match[2] ?? "");
  if (a === null || b === null)
    throw new DiffError(`unreadable diff header: ${line.slice(0, 120)}`);
  return [a, b];
}

function fileMode(mode: string | undefined): FileMode | "120000" | "160000" | undefined {
  if (mode === "120000" || mode === "160000" || mode === "100755") return mode;
  return mode === undefined ? undefined : "100644";
}

function side(mode: FileMode | "120000" | "160000", binary: boolean, lines: string[]): FileState {
  if (mode === "120000") return { kind: "symlink" };
  if (mode === "160000") return { kind: "submodule" };
  if (binary) return { kind: "binary", mode };
  return { kind: "text", mode, content: lines.map((line) => `${line}\n`).join("") };
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function readSection(lines: readonly string[]): ChangeInput {
  const [header = ""] = lines;
  let [oldPath, newPath] = headerPaths(header);
  let oldExists = true;
  let newExists = true;
  let oldMode: string | undefined;
  let newMode: string | undefined;
  let binary = false;
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let index = 1;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    index += 1;
    let match: RegExpExecArray | null;
    if ((match = /^new file mode (\d+)$/.exec(line)) !== null) {
      oldExists = false;
      newMode = match[1];
    } else if ((match = /^deleted file mode (\d+)$/.exec(line)) !== null) {
      newExists = false;
      oldMode = match[1];
    } else if ((match = /^old mode (\d+)$/.exec(line)) !== null) oldMode = match[1];
    else if ((match = /^new mode (\d+)$/.exec(line)) !== null) newMode = match[1];
    else if ((match = /^index \S+ (\d+)$/.exec(line)) !== null) {
      oldMode ??= match[1];
      newMode ??= match[1];
    } else if ((match = /^rename from (.+)$/.exec(line)) !== null)
      oldPath = sidePath(match[1] ?? "") ?? oldPath;
    else if ((match = /^rename to (.+)$/.exec(line)) !== null)
      newPath = sidePath(match[1] ?? "") ?? newPath;
    else if (/^Binary files .* differ$/.test(line)) binary = true;
    else if (line.startsWith("--- ")) {
      const path = sidePath(line.slice(4));
      if (path === null) oldExists = false;
      else oldPath = path;
    } else if (line.startsWith("+++ ")) {
      const path = sidePath(line.slice(4));
      if (path === null) newExists = false;
      else newPath = path;
    } else if ((match = HUNK.exec(line)) !== null) {
      let oldCount = Number(match[2] ?? "1");
      let newCount = Number(match[4] ?? "1");
      while ((oldCount > 0 || newCount > 0) && index < lines.length) {
        const body = lines[index] ?? "";
        index += 1;
        if (body.startsWith("\\")) continue;
        const text = body.slice(1);
        if (body.startsWith(" ") || body === "") {
          oldLines.push(text);
          newLines.push(text);
          oldCount -= 1;
          newCount -= 1;
        } else if (body.startsWith("-")) {
          oldLines.push(text);
          oldCount -= 1;
        } else if (body.startsWith("+")) {
          newLines.push(text);
          newCount -= 1;
        } else {
          break;
        }
      }
      if (oldCount !== 0 || newCount !== 0) {
        throw new DiffError(`${newPath}: a hunk's line counts don't match its header`);
      }
    } else if (line.startsWith("@@")) {
      throw new DiffError(`${newPath}: malformed hunk header`);
    }
  }
  const before = fileMode(oldMode) ?? "100644";
  const after = fileMode(newMode) ?? before;
  return {
    path: newExists ? newPath : oldPath,
    ...(newExists && oldExists && oldPath !== newPath ? { oldPath } : {}),
    old: oldExists ? side(before, binary, oldLines) : { kind: "absent" },
    new: newExists ? side(after, binary, newLines) : { kind: "absent" },
  };
}

/** The changes a `git diff` describes, or why it can't be read. */
export function parseUnifiedDiff(text: string): DiffRead {
  if (text.length > MAX_DIFF_CHARS) {
    return {
      ok: false,
      error: `the diff is too large (at most ${String(MAX_DIFF_CHARS)} characters)`,
    };
  }
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const sections: string[][] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ")) sections.push([line]);
    else sections.at(-1)?.push(line);
  }
  if (sections.length === 0) return { ok: false, error: "no `diff --git` sections found" };
  if (sections.length > MAX_DIFF_FILES) {
    return { ok: false, error: `too many files (at most ${String(MAX_DIFF_FILES)})` };
  }
  try {
    return { ok: true, changes: sections.map(readSection) };
  } catch (error) {
    if (error instanceof DiffError) return { ok: false, error: error.message };
    throw error;
  }
}
