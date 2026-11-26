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
    violations: ["draft"],
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
    violations: ["suppressions.forbid"],
  },
  {
    name: "warnings silenced in source",
    idea: 'warnings.filterwarnings("ignore") defeats -W error in the test config.',
    changes: [pyLine('import warnings\nwarnings.filterwarnings("ignore")')],
    violations: ["suppressions.forbid"],
  },
  // ================================================================== round 2 (after 3b71374)
  ...(
    [
      ["# pragma no cover", "coverage.py's default exclude regex makes the colon optional."],
      ["# pytype: disable=attribute-error", "pytype's directive."],
      ["# yapf: disable", "yapf formatter off."],
      ["# pyre-unsafe", "Drops a Pyre strict module to unsafe mode."],
    ] as const
  ).map(([line, idea]): Attack => ({
    name: `r2: ${line}`,
    idea,
    changes: [pyLine(line)],
    violations: ["suppressions.forbid"],
  })),
  ...(
    [
      ["// NOSONAR", "SonarQube's line suppression."],
      ["// cspell:disable-next-line", "cspell (a common CI spelling job)."],
      ["// dprint-ignore", "dprint formatter."],
    ] as const
  ).map(([line, idea]): Attack => ({
    name: `r2: ${line}`,
    idea,
    changes: [tsLine(line)],
    violations: ["suppressions.forbid"],
  })),
  {
    name: "r2: shellcheck, markdownlint, yamllint and svelte-ignore directives",
    idea: "Suppressions in shell, Markdown, YAML and Svelte files (the rule covers any file).",
    changes: [
      edit("scripts/build.sh", "rm -rf $DIR\n", "# shellcheck disable=SC2086\nrm -rf $DIR\n"),
      edit("README.md", "# Shop\n", "<!-- markdownlint-disable -->\n# Shop\n"),
      edit("config/app.yml", "a: 1\n", "a: 1 # yamllint disable-line rule:truthy\n"),
      edit(
        "src/Cart.svelte",
        "<div on:click={buy}>Buy</div>\n",
        "<!-- svelte-ignore a11y_click_events_have_key_events -->\n<div on:click={buy}>Buy</div>\n",
      ),
    ],
    violations: [
      "suppressions.forbid",
      "suppressions.forbid",
      "suppressions.forbid",
      "suppressions.forbid",
    ],
  },
  {
    name: "r2: an eslint-enable line deleted (the disable now runs to the end of the file)",
    idea: "Only added lines are read; deleting a closing directive widens an existing one.",
    changes: [
      edit(
        TS,
        `/* eslint-disable @typescript-eslint/no-explicit-any */\nconst legacy: any = 1;\n/* eslint-enable @typescript-eslint/no-explicit-any */\n${TS_BEFORE}`,
        `/* eslint-disable @typescript-eslint/no-explicit-any */\nconst legacy: any = 1;\n${TS_BEFORE}`,
      ),
    ],
    violations: ["suppressions.forbid"],
  },
  {
    name: "r2: // @ts-check deleted from a JavaScript file",
    idea: "With checkJs off, removing @ts-check switches type checking off for the file.",
    changes: [
      edit(
        "src/legacy.js",
        "// @ts-check\nexport const total = (prices) => prices.length;\n",
        "export const total = (prices) => prices.length;\n",
      ),
    ],
    violations: ["suppressions.forbid"],
  },
  {
    name: "r2: new code inside a function under an existing istanbul ignore next",
    idea: "`ignore next` covers the whole next node; only the line right under it is checked.",
    changes: [
      edit(
        TS,
        "/* istanbul ignore next */\nexport function debugDump(x: unknown) {\n  return String(x);\n}\n",
        '/* istanbul ignore next */\nexport function debugDump(x: unknown) {\n  if (x === null) return "";\n  return String(x);\n}\n',
      ),
    ],
    violations: ["suppressions.forbid"],
  },
  {
    name: "r2: new code in a function whose def has # pragma: no cover",
    idea: "coverage.py excludes the whole function body; only the def line is checked.",
    changes: [
      edit(
        PY,
        "def debug_dump(x):  # pragma: no cover\n    return str(x)\n",
        'def debug_dump(x):  # pragma: no cover\n    if x is None:\n        return ""\n    return str(x)\n',
      ),
    ],
    violations: ["suppressions.forbid"],
  },
];
