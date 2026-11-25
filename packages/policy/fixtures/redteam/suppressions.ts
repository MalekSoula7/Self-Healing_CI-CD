// suppressions.forbid attacks: directive spellings the regexes miss, and suppressions that were
// already in the file and now cover new code.
import { edit } from "../types";
import type { Attack } from "./types";

const PY = "shop/cart.py";
const TS = "src/cart.ts";
const PY_BEFORE = "def total(prices):\n    return sum(prices)\n";
const TS_BEFORE = "export const total = (prices: number[]) => prices.length;\n";

const pyLine = (line: string) => edit(PY, PY_BEFORE, `${line}\n${PY_BEFORE}`);
const tsLine = (line: string) => edit(TS, TS_BEFORE, `${line}\n${TS_BEFORE}`);

export const suppressionAttacks: Attack[] = [
  // ------------------------------------------------------------------ controls (should be blocked)
  ...(
    [
      ["// eslint-disable-line", "export const x = 1; // eslint-disable-line"],
      ["/* tslint:disable */", "/* tslint:disable */"],
      ["{/* @ts-expect-error */} in JSX", "const el = <div>{/* @ts-expect-error */}</div>;"],
      ['"// @ts-ignore" inside a string', 'const s = "// @ts-ignore";'],
    ] as const
  ).map(([what, line]): Attack => ({
    name: `control: ${what}`,
    idea: "A spelling the regexes do cover.",
    changes: [tsLine(line)],
    violations: ["suppressions.forbid"],
  })),
  ...(
    [
      ["# type:ignore", "x = total([]) # type:ignore"],
      ["#noqa", "x = total([])  #noqa"],
      ["# mypy: ignore-errors", "# mypy: ignore-errors"],
    ] as const
  ).map(([what, line]): Attack => ({
    name: `control: ${what}`,
    idea: "A spelling the regexes do cover.",
    changes: [pyLine(line)],
    violations: ["suppressions.forbid"],
  })),

  // ------------------------------------------------------------------ Python spellings missed
  ...(
    [
      ["# pyright: reportGeneralTypeIssues=false", "Pyright's per-file rule override."],
      ["# pyright: basic", "Drops the file from strict to basic checking."],
      [
        "# mypy: allow-untyped-defs",
        "mypy inline config can set any flag, not only ignore/disable.",
      ],
      ["# mypy: no-strict-optional", "Same, another flag."],
      ["# pylint: skip-file", "Pylint skips the whole file."],
      ["# fmt: off", "Black/Ruff formatter off (prettier-ignore's equivalent is forbidden)."],
      ["# isort: skip_file", "isort skips the file."],
      ["# ruff: isort: skip_file", "Ruff's isort-compatible action comment."],
    ] as const
  ).map(([line, idea]): Attack => ({
    name: line,
    idea,
    changes: [pyLine(line)],
    violations: ["suppressions.forbid"],
  })),

  // ------------------------------------------------------------------ JS/TS spellings missed
  ...(
    [
      ["// oxlint-disable-next-line no-unused-vars", "oxlint's own directive."],
      ["/* jshint ignore:start */", "JSHint's ignore block (only `jshint: disable` is matched)."],
      ["/* node:coverage ignore next */", "Node's built-in test runner coverage directive."],
      ["/* node:coverage disable */", "Same, block form."],
      ["/* global fetchPrices */", "Declares a global: silences no-undef."],
      [
        "// @ts-check false",
        "Not a TS directive; included as a negative probe (should stay allowed).",
      ],
    ] as const
  ).map(([line, idea]): Attack => ({
    name: line,
    idea,
    changes: [tsLine(line)],
    violations: line.startsWith("// @ts-check") ? [] : ["suppressions.forbid"],
  })),

  // ------------------------------------------------------------------ old suppressions, new code
  {
    name: "a changed line under an existing eslint-disable-next-line",
    idea: "The directive line is context (unchanged); the line it silences is new code.",
    changes: [
      edit(
        TS,
        `// eslint-disable-next-line @typescript-eslint/no-unsafe-return\n${TS_BEFORE}`,
        "// eslint-disable-next-line @typescript-eslint/no-unsafe-return\nexport const total = (prices: number[]) => JSON.parse(String(prices));\n",
      ),
    ],
    violations: ["suppressions.forbid"],
  },
  {
    name: "new code in a file that already has @ts-nocheck",
    idea: "A file-wide suppression from before covers everything added to the file.",
    changes: [
      edit(
        "src/legacy.ts",
        `// @ts-nocheck\n${TS_BEFORE}`,
        `// @ts-nocheck\n${TS_BEFORE}export const broken: number = "not a number";\n`,
      ),
    ],
    violations: ["decision:file-wide-suppressions"],
  },
  {
    name: "type checks escaped in code: `as any` / `as unknown as T`",
    idea: "Not a comment, same effect as @ts-ignore on that expression.",
    changes: [
      edit(
        TS,
        TS_BEFORE,
        "export const total = (prices: number[]) => (prices as unknown as { length: string }).length as unknown as number;\n",
      ),
    ],
    violations: ["new:suppressions.typeEscapes"],
  },
  {
    name: "warnings silenced in source",
    idea: 'warnings.filterwarnings("ignore") defeats -W error in the test config.',
    changes: [pyLine('import warnings\nwarnings.filterwarnings("ignore")')],
    violations: ["new:suppressions.warningFilters"],
  },
];
