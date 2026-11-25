// limits.maxFilesChanged and limits.maxLinesChanged (SPEC §8.5): lines added + removed.
import { add, edit, lines, type FixtureFamily } from "./types";

const files = (count: number) =>
  Array.from({ length: count }, (_, index) => edit(`src/f${String(index)}.ts`, "a\n", "b\n"));

export const size: FixtureFamily = {
  allowed: [
    { name: "exactly the file limit (default 5)", changes: files(5), violations: [] },
    {
      name: "exactly the line limit (default 150): 75 lines replaced",
      changes: [edit("src/a.ts", lines(75, "old"), lines(75, "new"))],
      violations: [],
    },
    {
      name: "a raised limit",
      policy: { limits: { maxFilesChanged: 8 } },
      changes: files(8),
      violations: [],
    },
  ],
  forbidden: [
    { name: "one file over the limit", changes: files(6), violations: ["limits.maxFilesChanged"] },
    {
      name: "one line over the limit",
      changes: [add("src/a.ts", lines(151))],
      violations: ["limits.maxLinesChanged"],
    },
    {
      name: "a lowered limit",
      policy: { limits: { maxFilesChanged: 1, maxLinesChanged: 3 } },
      changes: [edit("src/a.ts", "a\nb\n", "c\nd\n"), edit("src/b.ts", "a\n", "b\n")],
      violations: ["limits.maxFilesChanged", "limits.maxLinesChanged"],
    },
  ],
};
