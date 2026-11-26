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
const TEST = 'it("a", () => {\n  expect(f(1)).toBe(1);\n});\n';

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
        TEST.replace("it(", "it.skip(").replace("expect(f(1)).toBe(1);", ""),
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

  it("refuses a test file moved even within its test glob", () => {
    expect(
      check([rename("tests/a.test.ts", "tests/a.test.txt", TEST)], {
        tests: { ...EDITABLE, testGlobs: ["tests/**"] },
      }).map((violation) => violation.ruleId),
    ).toEqual(["INV-TEST-DELETE"]);
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

  it("reads early exits inside tests, not in helpers and callbacks", () => {
    const js = (body: string) =>
      check([add("src/a.test.ts", `it("a", () => {\n${body}\n  expect(f(1)).toBe(1);\n});\n`)], {
        tests: EDITABLE,
      }).map((violation) => violation.ruleId);
    const py = (body: string) =>
      check([add("tests/test_a.py", `def test_a():\n${body}\n    assert f(1)\n`)], {
        tests: EDITABLE,
      }).map((violation) => violation.ruleId);

    expect(js("  if (process.env.CI) {\n    return;\n  }")).toEqual(["tests.forbidSkips"]);
    expect(js("  items.forEach((item) => {\n    if (!item) return;\n  });")).toEqual([]);
    expect(js("  function helper(x) {\n    if (x) {\n      return 1;\n    }\n  }")).toEqual([]);
    expect(js("  process.exit(0);")).toEqual(["tests.forbidSkips"]);
    expect(js("  const s = 'a \\\n b';")).toEqual(["tests.forbidSkips"]);
    expect(py("    if os.environ.get('CI'):\n        return")).toEqual(["tests.forbidSkips"]);
    expect(py("    def helper():\n        if True:\n            return 1")).toEqual([]);
    expect(py("    sys.exit(0)")).toEqual(["tests.forbidSkips"]);
  });

  it("refuses a test file with line breaks runners read differently", () => {
    for (const odd of ["\r", " "]) {
      expect(
        check([add("tests/test_a.py", `def test_a():${odd}    return\n    assert f(1)\n`)], {
          tests: EDITABLE,
        }).map((violation) => violation.ruleId),
      ).toEqual(["tests.forbidSkips"]);
    }
  });

  it("follows a skip alias defined anywhere in the file", () => {
    const before = 'const later = cond ? it : it.skip;\nit("a", () => {});\n';
    const after = 'const later = cond ? it : it.skip;\nlater("a", () => {});\n';

    expect(
      check([edit("src/a.test.ts", before, after)], { tests: EDITABLE }).map((v) => v.ruleId),
    ).toContain("tests.forbidSkips");
  });
});
