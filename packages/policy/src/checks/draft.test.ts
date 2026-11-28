// CHECKPOINT 3 helpers: draft reasons, line weights, doctest lines.
import { describe, expect, it } from "vitest";
import { add, edit } from "../../fixtures/types";
import { buildChange } from "../diff";
import { checkChanges, effectivePolicy, type PolicyLayer } from "../index";
import { draftReasons } from "./draft";
import { lineWeight } from "./size";
import { doctestLines } from "./test-edits";

describe("draftReasons", () => {
  it.each([
    ["src/legacy.ts", "// @ts-nocheck\nexport const a = 1;\n"],
    ["src/legacy.js", "/* eslint-disable */\nexport const a = 1;\n"],
    ["shop/legacy.py", "# pylint: skip-file\na = 1\n"],
    ["shop/legacy.py", "# mypy: ignore-errors\na = 1\n"],
  ])("asks for a draft when %s switches checks off file-wide", (path, content) => {
    const change = buildChange(edit(path, content, `${content}export const b = 2;\n`));

    const reasons = draftReasons([change]);

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain(path);
  });

  it("lets the policy switch the CHECKPOINT 3 rules off with the rules they belong to", () => {
    const changes = [
      buildChange(
        add(
          "src/a.test.ts",
          'it("a", () => {\n  vi.retryTimes(2);\n  expect(true).toBe(true);\n});\n',
        ),
      ),
      buildChange(add("src/b.ts", "export const b = (x: unknown) => x as any;\n")),
    ];
    const ids = (repo: PolicyLayer) =>
      checkChanges(changes, effectivePolicy({ repo }).policy).map((violation) => violation.ruleId);
    const editable = { mode: "may_edit_tests" } as const;

    expect(ids({ tests: editable })).toEqual([
      "tests.forbidSkips",
      "tests.forbidAssertionReduction",
      "suppressions.forbid",
    ]);
    expect(
      ids({
        tests: { ...editable, forbidSkips: false, forbidAssertionReduction: false },
        suppressions: { forbid: false },
      }),
    ).toEqual([]);
  });

  it("doesn't for line-level directives, deletions or files without any", () => {
    expect(
      draftReasons([
        buildChange(
          edit(
            "src/a.ts",
            "// eslint-disable-next-line x\na;\n",
            "// eslint-disable-next-line x\nb;\n",
          ),
        ),
        buildChange(edit("src/b.ts", "// @ts-nocheck\na;\nb;\n", "// @ts-nocheck\na;\n")),
        buildChange(add("src/c.ts", "export {};\n")),
      ]),
    ).toEqual([]);
  });
});

describe("lineWeight", () => {
  it.each([
    ["const a = 1;", 1],
    ["for (let i = 0; i < n; i++) f(i);", 1],
    ["a(); b(); c(); d();", 4],
    ["x".repeat(200), 1],
    ["x".repeat(241), 3],
    ["total([]);".repeat(400), 400],
  ])("%j weighs %i", (text, weight) => {
    expect(lineWeight(text)).toBe(weight);
  });
});

describe("doctestLines", () => {
  it("marks prompts, continuations and expected output, up to a blank line or the docstring's end", () => {
    const content = [
      "def f(x):",
      '    """Double x.',
      "",
      "    >>> f(1)",
      "    2",
      "    >>> f(",
      "    ...   2)",
      "    4",
      '    """',
      "    return 2 * x",
    ].join("\n");

    expect([...doctestLines(content)]).toEqual([4, 5, 6, 7, 8]);
  });
});
