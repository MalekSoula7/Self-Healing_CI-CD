// SPEC §8.5: checks run on diffs the server recomputed from full old/new file contents. Written
// before the implementation.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_EDIT_DISTANCE, buildChange, diffLines, type FileState, type Hunk } from "./diff";

const text = (content: string, mode: "100644" | "100755" = "100644"): FileState => ({
  kind: "text",
  content,
  mode,
});
const absent: FileState = { kind: "absent" };

/** Applies hunks to the old lines; a correct diff gives back the new lines exactly. */
function applyHunks(oldLines: string[], hunks: Hunk[]): string[] {
  const result: string[] = [];
  let next = 0; // index in oldLines
  for (const hunk of hunks) {
    // Unified diff: a hunk with no old lines starts *after* oldStart; otherwise at it.
    const start = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
    result.push(...oldLines.slice(next, start));
    next = start;
    for (const line of hunk.lines) {
      if (line.type === "context") {
        expect(oldLines[next]).toBe(line.text);
        result.push(line.text);
        next += 1;
      } else if (line.type === "del") {
        expect(oldLines[next]).toBe(line.text);
        next += 1;
      } else {
        result.push(line.text);
      }
    }
  }
  result.push(...oldLines.slice(next));
  return result;
}

const lines = (content: string) => (content === "" ? [] : content.split("\n"));

describe("buildChange", () => {
  it("describes an added file: every line added", () => {
    const change = buildChange({ path: "src/a.ts", old: absent, new: text("a\nb\n") });

    expect(change).toMatchObject({
      path: "src/a.ts",
      oldPath: null,
      status: "added",
      isBinary: false,
      modeChanged: false,
      oldContent: null,
      newContent: "a\nb\n",
      addedLines: 3,
      removedLines: 0,
    });
    expect(change.hunks).toEqual([
      {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 3,
        lines: [
          { type: "add", text: "a" },
          { type: "add", text: "b" },
          { type: "add", text: "" },
        ],
      },
    ]);
  });

  it("describes a deleted file: every line removed", () => {
    const change = buildChange({ path: "src/a.ts", old: text("a\nb"), new: absent });

    expect(change).toMatchObject({
      status: "deleted",
      oldContent: "a\nb",
      newContent: null,
      addedLines: 0,
      removedLines: 2,
    });
  });

  it("describes a modified file with context around each change", () => {
    const old = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].join("\n");
    const updated = ["1", "2", "3", "4", "FIVE", "6", "7", "8", "9", "10"].join("\n");

    const change = buildChange({ path: "a.txt", old: text(old), new: text(updated) });

    expect(change).toMatchObject({ status: "modified", addedLines: 1, removedLines: 1 });
    expect(change.hunks).toEqual([
      {
        oldStart: 2,
        oldLines: 7,
        newStart: 2,
        newLines: 7,
        lines: [
          { type: "context", text: "2" },
          { type: "context", text: "3" },
          { type: "context", text: "4" },
          { type: "del", text: "5" },
          { type: "add", text: "FIVE" },
          { type: "context", text: "6" },
          { type: "context", text: "7" },
          { type: "context", text: "8" },
        ],
      },
    ]);
  });

  it("splits far-apart changes into separate hunks", () => {
    const old = Array.from({ length: 40 }, (_, i) => String(i)).join("\n");
    const updated = old.replace("\n5\n", "\nfive\n").replace("\n35\n", "\nthirty-five\n");

    const change = buildChange({ path: "a.txt", old: text(old), new: text(updated) });

    expect(change.hunks).toHaveLength(2);
    expect(change.hunks.map((hunk) => hunk.oldStart)).toEqual([3, 33]);
  });

  it("describes a rename: both paths, and the content change if any", () => {
    const change = buildChange({
      path: "src/new.ts",
      oldPath: "src/old.ts",
      old: text("x\n"),
      new: text("x\ny\n"),
    });

    expect(change).toMatchObject({
      path: "src/new.ts",
      oldPath: "src/old.ts",
      status: "renamed",
      addedLines: 1,
      removedLines: 0,
    });
  });

  it("has no hunks when nothing changed but the mode, and says the mode changed", () => {
    const change = buildChange({
      path: "run.sh",
      old: text("echo hi\n", "100644"),
      new: text("echo hi\n", "100755"),
    });

    expect(change).toMatchObject({ status: "modified", modeChanged: true, hunks: [] });
    expect(change.addedLines + change.removedLines).toBe(0);
  });

  it("counts line-ending and final-newline changes: whitespace is a change", () => {
    const crlf = buildChange({ path: "a.txt", old: text("a\nb\n"), new: text("a\r\nb\r\n") });
    const finalNewline = buildChange({ path: "a.txt", old: text("a\nb"), new: text("a\nb\n") });

    expect(crlf.addedLines).toBe(2);
    expect(crlf.removedLines).toBe(2);
    expect(finalNewline.addedLines).toBe(1);
  });

  it.each<[string, FileState, FileState]>([
    ["a binary file", { kind: "binary", mode: "100644" }, text("x")],
    ["a file becoming binary", text("x"), { kind: "binary", mode: "100644" }],
  ])("marks %s binary, with no content or hunks", (_label, old, updated) => {
    const change = buildChange({ path: "img.png", old, new: updated });

    expect(change).toMatchObject({ isBinary: true, hunks: [], addedLines: 0, removedLines: 0 });
    expect(change.oldContent === null || change.newContent === null).toBe(true);
  });

  it("records symlinks and submodules on either side", () => {
    const link = buildChange({ path: "link", old: { kind: "symlink" }, new: text("x") });
    const submodule = buildChange({ path: "vendor/lib", old: absent, new: { kind: "submodule" } });

    expect(link).toMatchObject({ oldKind: "symlink", newKind: "text", status: "modified" });
    expect(submodule).toMatchObject({ oldKind: "absent", newKind: "submodule", status: "added" });
  });

  it("refuses a change with nothing on either side", () => {
    expect(() => buildChange({ path: "a", old: absent, new: absent })).toThrow();
  });
});

describe("diffLines", () => {
  it("finds the minimal edit for interleaved changes", () => {
    const result = diffLines(["a", "b", "c", "a", "b", "b", "a"], ["c", "b", "a", "b", "a", "c"]);

    expect(result.added + result.removed).toBe(5);
  });

  it("falls back to replacing everything past MAX_EDIT_DISTANCE, which only overcounts", () => {
    const old = Array.from({ length: MAX_EDIT_DISTANCE }, (_, i) => `old ${String(i)}`);
    const updated = Array.from({ length: MAX_EDIT_DISTANCE }, (_, i) => `new ${String(i)}`);

    const started = Date.now();
    const result = diffLines(old, updated);

    expect(result.added).toBe(MAX_EDIT_DISTANCE);
    expect(result.removed).toBe(MAX_EDIT_DISTANCE);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("stays fast on a large file with a small change", () => {
    const old = Array.from({ length: 50_000 }, (_, i) => `line ${String(i)}`);
    const updated = [...old];
    updated[25_000] = "changed";

    const started = Date.now();
    const result = diffLines(old, updated);

    expect(result).toMatchObject({ added: 1, removed: 1 });
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("properties", () => {
  const content = fc
    .array(fc.constantFrom("a", "b", "c", "", "d e", "a\r"), { maxLength: 40 })
    .map((parts) => parts.join("\n"));

  it("applying the hunks to the old text gives the new text, and the counts match", () => {
    fc.assert(
      fc.property(content, content, (old, updated) => {
        const change = buildChange({ path: "f.txt", old: text(old), new: text(updated) });
        expect(applyHunks(lines(old), change.hunks)).toEqual(lines(updated));
        const added = change.hunks.flatMap((h) => h.lines).filter((l) => l.type === "add").length;
        const removed = change.hunks.flatMap((h) => h.lines).filter((l) => l.type === "del").length;
        expect([added, removed]).toEqual([change.addedLines, change.removedLines]);
        for (const hunk of change.hunks) {
          expect(hunk.lines.filter((l) => l.type !== "add")).toHaveLength(hunk.oldLines);
          expect(hunk.lines.filter((l) => l.type !== "del")).toHaveLength(hunk.newLines);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("is never worse than replacing everything, and empty only when nothing changed", () => {
    fc.assert(
      fc.property(content, content, (old, updated) => {
        const result = diffLines(lines(old), lines(updated));
        expect(result.added).toBeLessThanOrEqual(lines(updated).length);
        expect(result.removed).toBeLessThanOrEqual(lines(old).length);
        expect(result.added + result.removed === 0).toBe(old === updated);
      }),
      { numRuns: 500 },
    );
  });
});
