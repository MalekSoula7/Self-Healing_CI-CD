// suppressions.forbid (SPEC §8.5): suppression comments on added lines, in any file.
import { add, edit, type FixtureFamily } from "./types";

const source = "export function f(x: number) {\n  return x;\n}\n";

function withLine(line: string, path = "src/a.ts") {
  return edit(path, source, source.replace("  return x;", `${line}\n  return x;`));
}

export const suppressions: FixtureFamily = {
  allowed: [
    {
      name: "an ordinary comment",
      changes: [withLine("  // x is never negative here")],
      violations: [],
    },
    {
      name: "a suppression removed",
      changes: [
        edit(
          "src/a.ts",
          source.replace("  return x;", "  // @ts-expect-error legacy\n  return x;"),
          source,
        ),
      ],
      violations: [],
    },
    {
      name: "words that only look like suppressions",
      changes: [
        withLine("  // ignore negative values; disable the cache when x is 0; type: int"),
        add("src/types.py", "x = 1  # type: int\n"),
      ],
      violations: [],
    },
    {
      name: "suppression rules switched off",
      policy: { suppressions: { forbid: false } },
      changes: [withLine("  // eslint-disable-next-line no-console")],
      violations: [],
    },
  ],
  forbidden: [
    {
      name: "eslint-disable-next-line",
      changes: [withLine("  // eslint-disable-next-line no-console")],
      violations: ["suppressions.forbid"],
    },
    {
      name: "a file-wide eslint-disable",
      changes: [withLine("/* eslint-disable */")],
      violations: ["suppressions.forbid"],
    },
    {
      name: "an inline eslint rule config",
      changes: [withLine("/* eslint no-console: off */")],
      violations: ["suppressions.forbid"],
    },
    {
      name: "@ts-ignore",
      changes: [withLine("  // @ts-ignore")],
      violations: ["suppressions.forbid"],
    },
    {
      name: "@ts-expect-error",
      changes: [withLine("  // @ts-expect-error wrong type")],
      violations: ["suppressions.forbid"],
    },
    {
      name: "@ts-nocheck",
      changes: [withLine("// @ts-nocheck")],
      violations: ["suppressions.forbid"],
    },
    {
      name: "istanbul ignore",
      changes: [withLine("  /* istanbul ignore next */")],
      violations: ["suppressions.forbid"],
    },
    {
      name: "c8 ignore",
      changes: [withLine("  /* c8 ignore next */")],
      violations: ["suppressions.forbid"],
    },
    {
      name: "biome-ignore",
      changes: [withLine("  // biome-ignore lint/style: x")],
      violations: ["suppressions.forbid"],
    },
    {
      name: "prettier-ignore",
      changes: [withLine("  // prettier-ignore")],
      violations: ["suppressions.forbid"],
    },
    {
      name: "Python noqa, type: ignore and pylint disable on one fix",
      changes: [
        add(
          "src/app.py",
          "import os  # noqa: F401\nx: int = 'a'  # type: ignore[assignment]\n# pylint: disable=invalid-name\n",
        ),
      ],
      violations: ["suppressions.forbid", "suppressions.forbid", "suppressions.forbid"],
    },
    {
      name: "pragma: no cover, ruff and pyright",
      changes: [
        add(
          "src/b.py",
          "def f():  # pragma: no cover\n    pass\n# ruff: noqa\ny = f()  # pyright: ignore\n",
        ),
      ],
      violations: ["suppressions.forbid", "suppressions.forbid", "suppressions.forbid"],
    },
    {
      name: "a suppression in another case",
      changes: [withLine("  // ESLint-Disable-Next-Line")],
      violations: ["suppressions.forbid"],
    },
  ],
};
