// Code with comments and string contents blanked (SPEC §8.5: assertions are counted "in code with
// comments and strings stripped"). Written before the implementation.
import { describe, expect, it } from "vitest";
import { addedLines, languageOf, stripCode } from "./source";
import { buildChange } from "./diff";

/** Asserts what stripping keeps, and that offsets and line breaks never move. */
function strip(source: string, language: "js" | "python"): string {
  const stripped = stripCode(source, language);
  expect(stripped).toHaveLength(source.length);
  expect(stripped.split("\n")).toHaveLength(source.split("\n").length);
  return stripped;
}

describe("languageOf", () => {
  it.each([
    ["src/a.ts", "js"],
    ["src/a.test.TSX", "js"],
    ["x.mjs", "js"],
    ["x.cts", "js"],
    ["tests/test_a.py", "python"],
    ["stubs/a.pyi", "python"],
    ["README.md", null],
    ["src/__snapshots__/a.snap", null],
    ["Makefile", null],
  ])("%s is %s", (path, language) => {
    expect(languageOf(path)).toBe(language);
  });
});

describe("stripCode (JavaScript and TypeScript)", () => {
  it("blanks comments and string contents, keeping code and delimiters", () => {
    const stripped = strip(
      `const a = "expect(1)"; // expect(2)\n/* expect(3)\n */ expect(4); 'it\\'s'`,
      "js",
    );

    expect(stripped).toContain("expect(4)");
    expect(stripped.match(/expect/g)).toHaveLength(1);
    expect(stripped).toMatch(/"\s{9}"/);
    expect(stripped).toMatch(/'\s+'$/);
  });

  it("keeps code inside template expressions, nested templates included", () => {
    const stripped = strip("const s = `a ${expect(1)} b ${`c ${expect(2)}`} expect(3)`;", "js");

    expect(stripped.match(/expect\(/g)).toHaveLength(2);
    expect(stripped).not.toContain("expect(3)");
  });

  it("keeps a template's braces apart from code braces", () => {
    const stripped = strip("`${{ a: 1 }.a}`; if (x) { expect(1); }", "js");

    expect(stripped).toContain("expect(1)");
  });

  it("tells regular expressions from division", () => {
    expect(strip(`/["']/.test(x); expect(1)`, "js")).toContain("expect(1)");
    expect(strip(`if (/'/.test(x)) expect(1)`, "js")).toContain("expect(1)");
    expect(strip(`return /[/"]/.test(x) && expect(1)`, "js")).toContain("expect(1)");
    expect(strip(`a = b / c / d; expect(1)`, "js")).toContain("b / c / d");
    expect(strip(`f(x) / 2; g() / "s"; expect(1)`, "js")).toContain("expect(1)");
    expect(strip("/a\\/b/g; expect(1)", "js")).toContain("expect(1)");
  });

  it("keeps escaped backticks inside a template", () => {
    expect(strip("`a \\` expect(1)`; expect(2)", "js").match(/expect/g)).toHaveLength(1);
  });

  it("treats a slash that can't end on its line as division", () => {
    expect(strip("a = 1 /\n2; expect(1)", "js")).toContain("expect(1)");
    expect(strip("x = (/abc", "js")).toBe("x = (/abc");
  });

  it("ends unterminated quotes at the line break, and comments at the end", () => {
    expect(strip('const a = "open\nexpect(1)', "js")).toContain("expect(1)");
    expect(strip('"open', "js")).toBe('"    ');
    expect(strip("x /* expect(1)", "js")).not.toContain("expect");
    expect(strip("`a\nexpect(1)", "js")).not.toContain("expect");
    expect(strip("'a\\\nexpect(1)'", "js")).not.toContain("expect");
  });
});

describe("stripCode (Python)", () => {
  it("blanks comments and strings, triple-quoted ones across lines", () => {
    const stripped = strip(
      `x = "assert 1"  # assert 2\n"""doc\nassert 3\n"""\nassert 4\ny = r'\\d' + f"{z}" + '''a\nb'''`,
      "python",
    );

    expect(stripped.match(/assert/g)).toHaveLength(1);
    expect(stripped).toContain("assert 4");
    expect(stripped).toContain('"""');
  });

  it("handles escapes and line continuations", () => {
    expect(strip(`s = 'it\\'s' ; assert x`, "python")).toContain("assert x");
    expect(strip(`s = "a\\\nassert 1"\nassert 2`, "python")).not.toContain("assert 1");
    expect(strip(`s = "open\nassert 2`, "python")).toContain("assert 2");
    expect(strip(`s = """open\nassert 2`, "python")).not.toContain("assert");
    expect(strip(`s = 'open`, "python")).toBe("s = '    ");
  });
});

describe("stripCode (red-team cases, P3.6)", () => {
  it("reads f-string fields as code, with their own strings blanked", () => {
    const stripped = strip(
      `x = f"{ {'assert': 1}["assert"] } {{assert}} \\n {g(f'{h("assert")}')}"\nassert y`,
      "python",
    );

    expect(stripped.match(/assert/g)).toHaveLength(1);
    expect(stripped).toContain("g(f'{h(");
    expect(strip(`s = F"""a\n{b}\n"""\nassert c`, "python")).toContain("{b}");
    expect(strip(`s = f"open {a}\nassert c`, "python")).toContain("assert c");
    expect(strip(`s = f"{a`, "python")).toBe(`s = f"{a`);
  });

  it("stops reading nested f-strings as code past a depth", () => {
    const deep = `${'f"{'.repeat(20)}x${'}"'.repeat(20)}`;

    expect(strip(deep, "python")).toHaveLength(deep.length);
  });

  it("reads HTML-like comments in scripts", () => {
    expect(strip("x = 1 <!-- expect(1)\nexpect(2)", "js").match(/expect/g)).toHaveLength(1);
    expect(strip("x = 1\n  --> expect(1)\ny-- > 0", "js")).not.toContain("expect");
    expect(strip("y --> 0; expect(1)", "js")).toContain("expect(1)");
  });

  it("divides after a postfix ++ or --", () => {
    expect(strip("n++ / 2; it.skip(x) // it(s) /", "js")).toContain("it.skip(x)");
    expect(strip("n-- / 2; expect(1) /", "js")).toContain("expect(1)");
  });

  it("continues a quoted string over a backslash and CRLF", () => {
    expect(strip('a = "x \\\r\n"; expect(1)', "js")).toContain("expect(1)");
  });
});

describe("addedLines", () => {
  it("lists each added line with its 1-based number in the new content", () => {
    const change = buildChange({
      path: "a.ts",
      old: { kind: "text", content: "a\nb\nc\n", mode: "100644" },
      new: { kind: "text", content: "a\nx\nb\nc\ny\n", mode: "100644" },
    });

    expect(addedLines(change)).toEqual([
      { line: 2, text: "x" },
      { line: 5, text: "y" },
    ]);
  });
});
