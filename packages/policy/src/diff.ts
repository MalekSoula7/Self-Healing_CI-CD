// The diff model (SPEC §8.5, P3.2): every check runs on a Change the server built itself from the
// full old content (GitHub, at the target commit) and the full new content (the submission),
// never on a diff the runner sent. Pure.

/** Git file modes a regular file can have (symlinks and submodules are their own kinds). */
export type FileMode = "100644" | "100755";

/** One side of a file: what's at the path before, or after, the change. */
export type FileState =
  | { kind: "absent" }
  | { kind: "text"; content: string; mode: FileMode }
  | { kind: "binary"; mode: FileMode }
  | { kind: "symlink" }
  | { kind: "submodule" };
export type FileKind = FileState["kind"];

export interface ChangeInput {
  path: string;
  /** Set for a rename: where the file was. */
  oldPath?: string;
  old: FileState;
  new: FileState;
}

export interface HunkLine {
  type: "context" | "add" | "del";
  /** The line without its "\n" (a "\r" stays: line-ending changes are changes). */
  text: string;
}

/** A unified-diff hunk, 1-based like `git diff` (a side with no lines starts after `start`). */
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: HunkLine[];
}

export type ChangeStatus = "added" | "deleted" | "modified" | "renamed";

export interface Change {
  path: string;
  oldPath: string | null;
  status: ChangeStatus;
  oldKind: FileKind;
  newKind: FileKind;
  /** Either side is binary: there's no text diff, and INV-FILE-TYPES applies. */
  isBinary: boolean;
  /** Both sides are regular files with different modes (e.g. made executable). */
  modeChanged: boolean;
  /** Null when absent or not text. */
  oldContent: string | null;
  newContent: string | null;
  hunks: Hunk[];
  addedLines: number;
  removedLines: number;
}

/**
 * Edit scripts longer than this aren't computed exactly: the diff falls back to "every line
 * replaced". That only ever overcounts, and anything this large already exceeds the largest
 * possible maxLinesChanged (2,000), so the size check's verdict is the same.
 */
export const MAX_EDIT_DISTANCE = 2_100;
const CONTEXT_LINES = 3;

export interface DiffOp {
  type: "equal" | "del" | "add";
  text: string;
}

export interface LineDiff {
  ops: DiffOp[];
  added: number;
  removed: number;
}

/** A file's lines: split on "\n" (a final "\n" leaves an empty last line); none when empty. */
export function splitLines(content: string): string[] {
  return content === "" ? [] : content.split("\n");
}

/**
 * The shortest edit script from `a` to `b` (Myers' O((N+M)D) algorithm), after trimming the
 * common start and end; past MAX_EDIT_DISTANCE, every middle line is replaced.
 */
export function diffLines(a: readonly string[], b: readonly string[]): LineDiff {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);
  const middle = myers(middleA, middleB) ?? [
    ...middleA.map((text): DiffOp => ({ type: "del", text })),
    ...middleB.map((text): DiffOp => ({ type: "add", text })),
  ];
  const ops: DiffOp[] = [
    ...a.slice(0, start).map((text): DiffOp => ({ type: "equal", text })),
    ...middle,
    ...a.slice(endA).map((text): DiffOp => ({ type: "equal", text })),
  ];
  let added = 0;
  let removed = 0;
  for (const op of middle) {
    if (op.type === "add") added += 1;
    else if (op.type === "del") removed += 1;
  }
  return { ops, added, removed };
}

/** Myers' greedy algorithm; null when the edit distance exceeds MAX_EDIT_DISTANCE. */
/**
 * An index the algorithm guarantees is in range (the strict index checks can't know). Throws
 * rather than defaulting: a silent default would make a wrong diff look right.
 */
function item<T>(list: ArrayLike<T>, index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`diff: index ${String(index)} out of range`);
  return value;
}

function myers(a: readonly string[], b: readonly string[]): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, MAX_EDIT_DISTANCE);
  // v[k + offset]: the furthest x reached on diagonal k (y = x - k).
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  // trace[d]: v's diagonals -(d+1)..d+1 before step d, for backtracking.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && item(v, offset + k - 1) < item(v, offset + k + 1));
      let x = down ? item(v, offset + k + 1) : item(v, offset + k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace);
    }
  }
  return null;
}

function backtrack(a: readonly string[], b: readonly string[], trace: Int32Array[]): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = a.length;
  let y = b.length;
  for (const [d, saved] of [...trace.entries()].reverse()) {
    // saved[i] holds diagonal i - (d + 1).
    const at = (k: number) => item(saved, k + d + 1);
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ type: "equal", text: item(a, x) });
    }
    if (d > 0) {
      if (x === prevX) ops.push({ type: "add", text: item(b, y - 1) });
      else ops.push({ type: "del", text: item(a, x - 1) });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/** Groups an edit script into hunks with CONTEXT_LINES of context around each change. */
function toHunks(ops: readonly DiffOp[]): Hunk[] {
  const changed = ops.flatMap((op, index) => (op.type === "equal" ? [] : [index]));
  if (changed.length === 0) return [];

  // Ranges of ops to show: each change widened by its context, merged when they touch.
  const ranges: [number, number][] = [];
  for (const index of changed) {
    const from = Math.max(0, index - CONTEXT_LINES);
    const to = Math.min(ops.length - 1, index + CONTEXT_LINES);
    const last = ranges.at(-1);
    if (last !== undefined && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }

  // Line numbers before each op, on both sides.
  const oldBefore: number[] = [];
  const newBefore: number[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const op of ops) {
    oldBefore.push(oldLine);
    newBefore.push(newLine);
    if (op.type !== "add") oldLine += 1;
    if (op.type !== "del") newLine += 1;
  }

  return ranges.map(([from, to]) => {
    const slice = ops.slice(from, to + 1);
    const oldLines = slice.filter((op) => op.type !== "add").length;
    const newLines = slice.filter((op) => op.type !== "del").length;
    const oldFirst = item(oldBefore, from);
    const newFirst = item(newBefore, from);
    return {
      // 1-based; a side with no lines in the hunk names the line before it (as git does).
      oldStart: oldLines === 0 ? oldFirst : oldFirst + 1,
      oldLines,
      newStart: newLines === 0 ? newFirst : newFirst + 1,
      newLines,
      lines: slice.map((op): HunkLine => ({
        type: op.type === "equal" ? "context" : op.type,
        text: op.text,
      })),
    };
  });
}

function textOf(state: FileState): string | null {
  return state.kind === "text" ? state.content : null;
}

function modeOf(state: FileState): FileMode | null {
  return state.kind === "text" || state.kind === "binary" ? state.mode : null;
}

/** The change from `old` to `new` at a path (or from `oldPath` to `path` for a rename). */
export function buildChange(input: ChangeInput): Change {
  const { old, new: next } = input;
  if (old.kind === "absent" && next.kind === "absent") {
    throw new Error("a change needs a file on at least one side");
  }
  const renamedFrom =
    input.oldPath !== undefined && input.oldPath !== input.path ? input.oldPath : null;
  const status: ChangeStatus =
    old.kind === "absent"
      ? "added"
      : next.kind === "absent"
        ? "deleted"
        : renamedFrom !== null
          ? "renamed"
          : "modified";
  const isBinary = old.kind === "binary" || next.kind === "binary";
  const oldMode = modeOf(old);
  const newMode = modeOf(next);
  const oldContent = textOf(old);
  const newContent = textOf(next);

  // A text diff only when neither side is binary, a symlink or a submodule.
  const diffable =
    (old.kind === "text" || old.kind === "absent") &&
    (next.kind === "text" || next.kind === "absent");
  const diff = diffable
    ? diffLines(splitLines(oldContent ?? ""), splitLines(newContent ?? ""))
    : null;

  return {
    path: input.path,
    oldPath: status === "renamed" ? renamedFrom : null,
    status,
    oldKind: old.kind,
    newKind: next.kind,
    isBinary,
    modeChanged: oldMode !== null && newMode !== null && oldMode !== newMode,
    oldContent,
    newContent,
    hunks: diff === null ? [] : toHunks(diff.ops),
    addedLines: diff?.added ?? 0,
    removedLines: diff?.removed ?? 0,
  };
}
