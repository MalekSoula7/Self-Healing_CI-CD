// A pasted `git diff` into changes for a dry run (SPEC §8.9, P3.10). Written before the
// implementation.
import { describe, expect, it } from "vitest";
import { buildChange, checkChanges, effectivePolicy } from "./index";
import { MAX_DIFF_CHARS, MAX_DIFF_FILES, parseUnifiedDiff } from "./unified-diff";

const EDIT = `diff --git a/src/cart.ts b/src/cart.ts
index 1111111..2222222 100644
--- a/src/cart.ts
+++ b/src/cart.ts
@@ -1,3 +1,3 @@
 export function total(prices: number[]): number {
-  return prices.length;
+  return prices.reduce((sum, price) => sum + price, 0);
 }
`;

describe("parseUnifiedDiff", () => {
  it("reads an edit, rebuilding each side from the hunk's lines", () => {
    const read = parseUnifiedDiff(EDIT);

    expect(read).toEqual({
      ok: true,
      changes: [
        {
          path: "src/cart.ts",
          old: {
            kind: "text",
            mode: "100644",
            content:
              "export function total(prices: number[]): number {\n  return prices.length;\n}\n",
          },
          new: {
            kind: "text",
            mode: "100644",
            content:
              "export function total(prices: number[]): number {\n  return prices.reduce((sum, price) => sum + price, 0);\n}\n",
          },
        },
      ],
    });
  });

  it("reads new, deleted, renamed, binary, symlink, submodule and mode changes", () => {
    const diff = [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1 @@",
      "+export {};",
      "diff --git a/src/old.test.ts b/src/old.test.ts",
      "deleted file mode 100644",
      "--- a/src/old.test.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-it('x', () => {});",
      "diff --git a/lib/a.ts b/lib/b.ts",
      "similarity index 100%",
      "rename from lib/a.ts",
      "rename to lib/b.ts",
      "diff --git a/logo.png b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
      "diff --git a/link b/link",
      "new file mode 120000",
      "diff --git a/vendor/lib b/vendor/lib",
      "index 1111111..2222222 160000",
      "diff --git a/bin/run.sh b/bin/run.sh",
      "old mode 100644",
      "new mode 100755",
      "",
    ].join("\n");
    const read = parseUnifiedDiff(diff);
    if (!read.ok) throw new Error(read.error);
    const changes = read.changes.map(buildChange);

    expect(changes.map((change) => [change.path, change.status])).toEqual([
      ["src/new.ts", "added"],
      ["src/old.test.ts", "deleted"],
      ["lib/b.ts", "renamed"],
      ["logo.png", "modified"],
      ["link", "added"],
      ["vendor/lib", "modified"],
      ["bin/run.sh", "modified"],
    ]);
    expect(changes[3]?.isBinary).toBe(true);
    expect(changes[4]?.newKind).toBe("symlink");
    expect(changes[5]?.newKind).toBe("submodule");
    expect(changes[6]?.modeChanged).toBe(true);
  });

  it("feeds the static checks", () => {
    const read = parseUnifiedDiff(
      EDIT.replace("+  return prices.reduce", "+  // @ts-ignore\n+  return prices.reduce").replace(
        "@@ -1,3 +1,3 @@",
        "@@ -1,3 +1,4 @@",
      ),
    );
    if (!read.ok) throw new Error(read.error);
    const ids = checkChanges(read.changes.map(buildChange), effectivePolicy({}).policy).map(
      (violation) => violation.ruleId,
    );

    expect(ids).toEqual(["suppressions.forbid"]);
  });

  it.each([
    ["no diff at all", "just some text"],
    ["a path outside the repository", EDIT.replaceAll("src/cart.ts", "../etc/passwd")],
    ["a hunk header that doesn't add up", EDIT.replace("@@ -1,3 +1,3 @@", "@@ -1,9 +1,9 @@")],
    ["a malformed hunk header", EDIT.replace("@@ -1,3 +1,3 @@", "@@ nonsense @@")],
    ["too large", `${EDIT}${" ".repeat(MAX_DIFF_CHARS)}`],
    [
      "too many files",
      Array.from({ length: MAX_DIFF_FILES + 1 }, (_, index) =>
        EDIT.replaceAll("src/cart.ts", `src/f${String(index)}.ts`),
      ).join(""),
    ],
  ])("refuses %s", (_, text) => {
    expect(parseUnifiedDiff(text).ok).toBe(false);
  });

  it("reads CRLF diffs and a quoted path", () => {
    const read = parseUnifiedDiff(EDIT.replaceAll("\n", "\r\n"));
    const quoted = parseUnifiedDiff(
      EDIT.replace(
        "diff --git a/src/cart.ts b/src/cart.ts",
        'diff --git "a/src/c art.ts" "b/src/c art.ts"',
      )
        .replace("--- a/src/cart.ts", '--- "a/src/c art.ts"')
        .replace("+++ b/src/cart.ts", '+++ "b/src/c art.ts"'),
    );

    expect(read.ok && read.changes[0]?.path).toBe("src/cart.ts");
    expect(quoted.ok && quoted.changes[0]?.path).toBe("src/c art.ts");
  });

  it("reads quoted escapes, executable files and missing final newlines", () => {
    const diff = [
      'diff --git "a/src/say\\"hi\\".sh" "b/src/say\\"hi\\".sh"',
      "new file mode 100755",
      "--- /dev/null",
      '+++ "b/src/say\\"hi\\".sh"',
      "@@ -0,0 +1 @@",
      "+echo hi",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const read = parseUnifiedDiff(diff);
    if (!read.ok) throw new Error(read.error);

    expect(read.changes[0]).toMatchObject({
      path: 'src/say"hi".sh',
      new: { kind: "text", mode: "100755", content: "echo hi\n" },
    });
  });

  it.each([
    ["an unreadable header", "diff --git nonsense\n"],
    ["a line that isn't part of the hunk", EDIT.replace("-  return prices.length;", "?  return")],
  ])("refuses %s", (_, text) => {
    expect(parseUnifiedDiff(text).ok).toBe(false);
  });
});
