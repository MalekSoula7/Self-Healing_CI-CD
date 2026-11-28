import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEMO_MARKERS,
  SCENARIOS,
  ScenarioError,
  applyEdits,
  findScenario,
  type Demo,
  type RepoFiles,
} from "./break-scenarios";

const EXAMPLES = new URL("../../examples/", import.meta.url);

/** The demo repo as committed in examples/, with writes kept in memory. */
function demoFiles(demo: Demo): RepoFiles & { written: Map<string, string> } {
  const written = new Map<string, string>();
  return {
    written,
    read: (path) => {
      const url = new URL(`demo-${demo}/${path}`, EXAMPLES);
      return existsSync(url) ? readFileSync(url, "utf8") : null;
    },
    write: (path, content) => written.set(path, content),
  };
}

function memoryFiles(initial: Record<string, string>): RepoFiles & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
    read: (path) => files.get(path) ?? null,
    write: (path, content) => files.set(path, content),
  };
}

describe("scenarios", () => {
  it("covers every eval scenario of SPEC §14", () => {
    const names = new Set(SCENARIOS.map((s) => s.id.split("/")[1]));
    expect([...names].sort()).toEqual(
      [
        "type-error",
        "logic-bug",
        "missing-import",
        "lint",
        "missing-dependency",
        "trap-test",
        "trap-injection",
        "flaky",
        "missing-secret",
      ].sort(),
    );
  });

  it("have unique IDs, prefixed with their demo", () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scenario of SCENARIOS)
      expect(scenario.id.startsWith(`${scenario.demo}/`)).toBe(true);
    expect(findScenario("node/type-error")?.demo).toBe("node");
    expect(findScenario("nope")).toBeUndefined();
  });

  it.each(["node", "python"] as const)("finds the %s demo by its marker file", (demo) => {
    const marker = DEMO_MARKERS[demo];
    expect(demoFiles(demo).read(marker.path)).toContain(marker.contains);
  });

  it.each(SCENARIOS.map((s) => [s.id, s] as const))(
    "%s applies cleanly to the demo as committed, and changes it",
    (_id, scenario) => {
      const files = demoFiles(scenario.demo);

      const changed = applyEdits(files, scenario.edits);

      expect(changed.length).toBeGreaterThan(0);
      for (const path of changed) {
        expect(files.written.get(path)).not.toBe(files.read(path));
      }
    },
  );

  it("never gives the trap away in the commit message", () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.commitMessage).not.toMatch(/break|trap|scenario|flaky|eval|pipeheal/i);
    }
  });
});

describe("applyEdits", () => {
  it("applies edits in order, several to the same file", () => {
    const files = memoryFiles({ "a.ts": "one two" });

    applyEdits(files, [
      { kind: "replace", path: "a.ts", find: "one", replace: "1" },
      { kind: "replace", path: "a.ts", find: "1 two", replace: "1 2" },
      { kind: "create", path: "dir/b.ts", content: "new" },
    ]);

    expect(Object.fromEntries(files.files)).toEqual({ "a.ts": "1 2", "dir/b.ts": "new" });
  });

  it("writes nothing when any edit doesn't apply", () => {
    const files = memoryFiles({ "a.ts": "one", "b.ts": "two" });

    expect(() =>
      applyEdits(files, [
        { kind: "replace", path: "a.ts", find: "one", replace: "1" },
        { kind: "replace", path: "b.ts", find: "three", replace: "3" },
      ]),
    ).toThrow(ScenarioError);
    expect(Object.fromEntries(files.files)).toEqual({ "a.ts": "one", "b.ts": "two" });
  });

  it.each([
    ["text not found", { kind: "replace", path: "a.ts", find: "zzz", replace: "" }],
    ["text found twice", { kind: "replace", path: "a.ts", find: "o", replace: "" }],
    ["file missing", { kind: "replace", path: "missing.ts", find: "o", replace: "" }],
    ["file already exists", { kind: "create", path: "a.ts", content: "" }],
  ] as const)("refuses an edit when the %s", (_case, edit) => {
    expect(() => applyEdits(memoryFiles({ "a.ts": "foo" }), [edit])).toThrow(ScenarioError);
  });

  it("inserts replacement text literally, `$` patterns included", () => {
    const files = memoryFiles({ "ci.yml": "steps:\n" });

    applyEdits(files, [
      {
        kind: "replace",
        path: "ci.yml",
        find: "steps:\n",
        replace: "env: ${{ secrets.X }} $& $1\n",
      },
    ]);

    expect(files.files.get("ci.yml")).toBe("env: ${{ secrets.X }} $& $1\n");
  });
});
