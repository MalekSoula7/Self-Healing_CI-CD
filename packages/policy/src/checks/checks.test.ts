// Details the fixtures don't pin down: line numbers, switched-off rules, edge positions.
import { describe, expect, it } from "vitest";
import { add, edit, rename } from "../../fixtures/types";
import {
  buildChange,
  checkChanges,
  effectivePolicy,
  type ChangeInput,
  type PolicyLayer,
} from "../index";

function check(changes: ChangeInput[], repo: PolicyLayer = {}) {
  return checkChanges(changes.map(buildChange), effectivePolicy({ repo }).policy);
}

const EDITABLE = { mode: "may_edit_tests" } as const;
const TEST = 'it("a", () => {\n  expect(1).toBe(1);\n});\n';

describe("checkChanges", () => {
  it("reports the line of each added skip and suppression", () => {
    const violations = check(
      [edit("src/a.test.ts", TEST, `// @ts-nocheck\n${TEST.replace("it(", "it.skip(")}`)],
      { tests: EDITABLE },
    );

    expect(violations.map(({ ruleId, path, line }) => ({ ruleId, path, line }))).toEqual([
      { ruleId: "tests.forbidSkips", path: "src/a.test.ts", line: 2 },
      { ruleId: "suppressions.forbid", path: "src/a.test.ts", line: 1 },
    ]);
  });

  it("lets a policy switch the test-integrity rules off", () => {
    const changes = [
      edit(
        "src/a.test.ts",
        TEST,
        TEST.replace("it(", "it.skip(").replace("expect(1).toBe(1);", ""),
      ),
    ];

    expect(
      check(changes, {
        tests: { ...EDITABLE, forbidSkips: false, forbidAssertionReduction: false },
      }),
    ).toEqual([]);
  });

  it("doesn't call a return on the file's last line an early exit", () => {
    expect(
      check([add("src/a.test.ts", `${TEST}function f() {\n  return`)], { tests: EDITABLE }),
    ).toEqual([]);
  });

  it("reads skips only in test files in a language it knows", () => {
    expect(
      check([edit("src/__snapshots__/a.snap", "a\n", "it.skip(\n")], { tests: EDITABLE }),
    ).toEqual([]);
  });

  it("doesn't count a test file moved to a name in no language it knows", () => {
    expect(
      check([rename("tests/a.test.ts", "tests/a.test.txt", TEST)], {
        tests: { ...EDITABLE, testGlobs: ["tests/**"] },
      }),
    ).toEqual([]);
  });

  it("reports a new package as dependencies.mode while frozen, even if new packages are allowed", () => {
    const violations = check(
      [edit("package.json", '{"dependencies": {}}\n', '{"dependencies": {"zod": "4.1.0"}}\n')],
      { dependencies: { allowNew: true } },
    );

    expect(violations.map((violation) => violation.ruleId)).toEqual(["dependencies.mode"]);
  });

  it("reads protected sections of manifests in any shape", () => {
    const configs = (before: string | null, after: string, path = "pyproject.toml") =>
      check([before === null ? add(path, after) : edit(path, before, after)], {
        dependencies: { mode: "any", allowNew: true },
      }).map((violation) => violation.ruleId);

    // A package.json that isn't an object is reported by the dependency check alone.
    expect(configs('{"scripts": {}}\n', "[]\n", "package.json")).toEqual(["dependencies.mode"]);
    expect(configs("", "tool = 1\n")).toEqual([]);
    expect(configs("[tool]\nblack = 1\n", "[tool]\nblack = 2\n")).toEqual(["protectedConfigs"]);
    expect(configs(null, "[tool.ruff]\nline-length = 200\n")).toEqual(["protectedConfigs"]);
    expect(configs(null, '[tool.poetry.dependencies]\nzod = "1.0.0"\n')).toEqual([]);
  });
});
