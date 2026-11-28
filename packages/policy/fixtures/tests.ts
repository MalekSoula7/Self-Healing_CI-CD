// Test integrity (SPEC §8.5): tests.mode, tests.forbidSkips (skip markers and early exits) and
// tests.forbidAssertionReduction. Except for tests.mode's own fixtures, tests may be edited here,
// so each fixture shows one rule at work.
import type { PolicyLayer } from "../src/index";
import { add, edit, rename, type FixtureFamily } from "./types";

const EDITABLE: PolicyLayer = { tests: { mode: "may_edit_tests" } };

const JS_TEST = `import { describe, expect, it } from "vitest";
import { total } from "./cart";

describe("total", () => {
  it("adds prices", () => {
    expect(total([1, 2])).toBe(3);
  });

  it("is zero when empty", () => {
    expect(total([])).toBe(0);
  });
});
`;

const PY_TEST = `import pytest
from shop.cart import total


def test_adds_prices():
    assert total([1, 2]) == 3


def test_rejects_negative():
    with pytest.raises(ValueError):
        total([-1])
`;

export const testEdits: FixtureFamily = {
  allowed: [
    {
      name: "a source change next to its tests",
      changes: [edit("src/cart.ts", "export const total = 0;\n", "export const total = 1;\n")],
      violations: [],
    },
    {
      name: "a test edit when tests may be edited",
      policy: EDITABLE,
      changes: [
        edit("src/cart.test.ts", JS_TEST, JS_TEST.replace("[1, 2])).toBe(3)", "[1, 3])).toBe(4)")),
      ],
      violations: [],
    },
  ],
  forbidden: [
    {
      name: "a test edit (source_only, the default)",
      changes: [edit("src/cart.test.ts", JS_TEST, JS_TEST.replace("toBe(3)", "toBe(4)"))],
      violations: ["tests.mode"],
    },
    {
      name: "a new test file",
      changes: [add("tests/test_new.py", "def test_x():\n    assert add(1, 1) == 2\n")],
      violations: ["tests.mode"],
    },
    {
      name: "a snapshot update",
      changes: [
        edit(
          "src/__snapshots__/cart.test.ts.snap",
          "exports[`a`] = `1`;\n",
          "exports[`a`] = `2`;\n",
        ),
      ],
      violations: ["tests.mode"],
    },
    {
      name: "test data",
      changes: [edit("tests/fixtures/cart.json", "[1]\n", "[2]\n")],
      violations: ["tests.mode"],
    },
    {
      name: "a test file under another case",
      changes: [edit("src/Cart.Test.ts", "a\n", "b\n")],
      violations: ["tests.mode"],
    },
    {
      name: "a source file moved into a test path",
      changes: [rename("src/helper.ts", "src/__tests__/helper.ts", "export {};\n")],
      violations: ["tests.mode"],
    },
    {
      name: "pytest's conftest",
      changes: [edit("conftest.py", "import pytest\n", "import pytest\nimport os\n")],
      violations: ["tests.mode"],
    },
  ],
};

export const skips: FixtureFamily = {
  allowed: [
    {
      name: "a new test",
      policy: EDITABLE,
      changes: [
        edit(
          "src/cart.test.ts",
          JS_TEST,
          JS_TEST.replace(
            '  it("is zero when empty"',
            '  it("ignores zero", () => {\n    expect(total([0])).toBe(0);\n  });\n\n  it("is zero when empty"',
          ),
        ),
      ],
      violations: [],
    },
    {
      name: "skip words in names",
      policy: EDITABLE,
      changes: [
        edit(
          "src/cart.test.ts",
          JS_TEST,
          JS_TEST.replace(
            "expect(total([1, 2])).toBe(3);",
            "const skipped = 0;\n    expect(total([1, 2], skipped)).toBe(3);",
          ),
        ),
      ],
      violations: [],
    },
    {
      name: ".skip( in source code (a query builder)",
      changes: [edit("src/db.ts", "q.limit(10);\n", "q.skip(10).limit(10);\n")],
      violations: [],
    },
    {
      name: "a test returning its promise, and a helper returning early",
      policy: EDITABLE,
      changes: [
        edit(
          "src/cart.test.ts",
          JS_TEST,
          JS_TEST.replace(
            "    expect(total([])).toBe(0);",
            "    return expect(Promise.resolve(total([]))).resolves.toBe(0);",
          ) +
            "\nfunction price(item?: number) {\n  if (item === undefined) {\n    return 0;\n  }\n  return item;\n}\n",
        ),
      ],
      violations: [],
    },
    {
      name: "a multi-line return value",
      policy: EDITABLE,
      changes: [
        add(
          "src/view.test.tsx",
          'import { expect, it } from "vitest";\n\nfunction view() {\n  return (\n    <div />\n  );\n}\n\nit("renders", () => {\n  expect(view()).toBeTruthy();\n});\n',
        ),
      ],
      violations: [],
    },
    {
      name: "a Python test that names skipping",
      policy: EDITABLE,
      changes: [
        edit(
          "tests/test_cart.py",
          PY_TEST,
          PY_TEST +
            "\n\ndef test_skip_zero():\n    assert total([0, 1]) == 1  # zero is a valid price\n",
        ),
      ],
      violations: [],
    },
  ],
  forbidden: [
    {
      // Counted on the whole file, comments and strings included: fail closed.
      name: "skip markers even in a comment and a string",
      policy: EDITABLE,
      changes: [
        edit(
          "src/cart.test.ts",
          JS_TEST,
          JS_TEST.replace(
            "expect(total([1, 2])).toBe(3);",
            '// never it.skip( this\n    const label = "it.only(";\n    expect(total([1, 2], label)).toBe(3);',
          ),
        ),
      ],
      violations: ["tests.forbidSkips"],
    },
    {
      name: "it.skip",
      policy: EDITABLE,
      changes: [edit("src/cart.test.ts", JS_TEST, JS_TEST.replace('it("adds', 'it.skip("adds'))],
      violations: ["tests.forbidSkips"],
    },
    {
      name: "describe.only and a skipIf",
      policy: EDITABLE,
      changes: [
        edit(
          "src/cart.test.ts",
          JS_TEST,
          JS_TEST.replace('describe("total"', 'describe.only("total"').replace(
            'it("is zero',
            'it.skipIf(process.env.CI)("is zero',
          ),
        ),
      ],
      violations: ["tests.forbidSkips"],
    },
    {
      name: "xit, and a skip through an alias",
      policy: EDITABLE,
      changes: [
        edit(
          "src/cart.test.ts",
          JS_TEST,
          JS_TEST.replace('it("adds', 'xit("adds').replace(
            "describe(",
            "const later = it.todo;\ndescribe(",
          ),
        ),
      ],
      violations: ["tests.forbidSkips"],
    },
    {
      name: "Playwright's test.fixme",
      policy: EDITABLE,
      changes: [
        add(
          "e2e/cart.spec.ts",
          'import { test } from "@playwright/test";\n\ntest.fixme("checkout", async () => {});\n',
        ),
      ],
      violations: ["tests.forbidSkips"],
    },
    {
      name: "pytest skip and xfail markers",
      policy: EDITABLE,
      changes: [
        edit(
          "tests/test_cart.py",
          PY_TEST,
          PY_TEST.replace(
            "def test_adds_prices",
            "@pytest.mark.xfail\ndef test_adds_prices",
          ).replace(
            "def test_rejects_negative",
            '@pytest.mark.skipif(True, reason="later")\ndef test_rejects_negative',
          ),
        ),
      ],
      violations: ["tests.forbidSkips"],
    },
    {
      name: "unittest skips, imperative and decorated",
      policy: EDITABLE,
      changes: [
        add(
          "tests/test_api.py",
          "import unittest\nfrom unittest import skip\n\n\nclass T(unittest.TestCase):\n    @skip\n    def test_a(self):\n        self.assertTrue(True)\n\n    def test_b(self):\n        self.skipTest('flaky')\n        pytest.skip('x')\n",
        ),
      ],
      violations: ["tests.forbidSkips"],
    },
    {
      name: "a return before the assertions",
      policy: EDITABLE,
      changes: [
        edit(
          "src/cart.test.ts",
          JS_TEST,
          JS_TEST.replace("    expect(total([1, 2]))", "    return;\n    expect(total([1, 2]))"),
        ),
      ],
      violations: ["tests.forbidSkips"],
    },
    {
      name: "a return and an assertion on one line",
      policy: EDITABLE,
      changes: [
        edit(
          "src/cart.test.ts",
          JS_TEST,
          JS_TEST.replace("    expect(total([1, 2]))", "    return; expect(total([1, 2]))"),
        ),
      ],
      violations: ["tests.forbidSkips"],
    },
    {
      name: "if (false) around an assertion",
      policy: EDITABLE,
      changes: [
        edit(
          "src/cart.test.ts",
          JS_TEST,
          JS_TEST.replace(
            "    expect(total([])).toBe(0);",
            "    if (false) {\n      expect(total([])).toBe(0);\n    }",
          ),
        ),
      ],
      violations: ["tests.forbidSkips"],
    },
    {
      name: "a Python early return and if False",
      policy: EDITABLE,
      changes: [
        edit(
          "tests/test_cart.py",
          PY_TEST,
          PY_TEST.replace(
            "    assert total([1, 2]) == 3",
            "    return\n    assert total([1, 2]) == 3",
          )
            .replace("    with pytest.raises", "    if False:\n      with pytest.raises")
            .replace("        total([-1])", "          total([-1])"),
        ),
      ],
      violations: ["tests.forbidSkips", "tests.forbidSkips"],
    },
  ],
};

export const assertions: FixtureFamily = {
  allowed: [
    {
      name: "an assertion changed, not removed",
      policy: EDITABLE,
      changes: [edit("src/cart.test.ts", JS_TEST, JS_TEST.replace("toBe(3)", "toEqual(3)"))],
      violations: [],
    },
    {
      name: "an assertion added",
      policy: EDITABLE,
      changes: [
        edit(
          "src/cart.test.ts",
          JS_TEST,
          JS_TEST.replace(
            "    expect(total([])).toBe(0);",
            "    expect(total([])).toBe(0);\n    expect(total([0])).toBe(0);",
          ),
        ),
      ],
      violations: [],
    },
    {
      name: "unittest style becomes pytest style, one for one",
      policy: EDITABLE,
      changes: [
        edit(
          "tests/test_math.py",
          "import unittest\n\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertEqual(1 + 1, 2)\n",
          "def test_a():\n    assert 1 + 1 == 2\n",
        ),
      ],
      violations: [],
    },
  ],
  forbidden: [
    {
      name: "a test file renamed, even to another test path",
      policy: EDITABLE,
      changes: [rename("tests/test_cart.py", "tests/unit/test_cart.py", PY_TEST)],
      violations: ["INV-TEST-DELETE"],
    },
    {
      name: "an assertion deleted",
      policy: EDITABLE,
      changes: [
        edit(
          "src/cart.test.ts",
          JS_TEST,
          JS_TEST.replace("    expect(total([])).toBe(0);\n", "    total([]);\n"),
        ),
      ],
      violations: ["tests.forbidAssertionReduction"],
    },
    {
      name: "an assertion commented out",
      policy: EDITABLE,
      changes: [
        edit(
          "src/cart.test.ts",
          JS_TEST,
          JS_TEST.replace("    expect(total([])).toBe(0);", "    // expect(total([])).toBe(0);"),
        ),
      ],
      violations: ["tests.forbidAssertionReduction"],
    },
    {
      name: "an assertion turned into a string",
      policy: EDITABLE,
      changes: [
        edit(
          "src/cart.test.ts",
          JS_TEST,
          JS_TEST.replace("    expect(total([])).toBe(0);", '    "expect(total([])).toBe(0)";'),
        ),
      ],
      violations: ["tests.forbidAssertionReduction"],
    },
    {
      name: "two tests merged into one",
      policy: EDITABLE,
      changes: [
        edit(
          "src/cart.test.ts",
          JS_TEST,
          JS_TEST.replace('  });\n\n  it("is zero when empty", () => {\n', ""),
        ),
      ],
      violations: ["tests.forbidAssertionReduction"],
    },
    {
      name: "a whole test commented out",
      policy: EDITABLE,
      changes: [
        edit(
          "tests/test_cart.py",
          PY_TEST,
          PY_TEST.replace(
            "def test_rejects_negative():\n    with pytest.raises(ValueError):\n        total([-1])",
            "# def test_rejects_negative():\n#     with pytest.raises(ValueError):\n#         total([-1])",
          ),
        ),
      ],
      violations: ["tests.forbidAssertionReduction", "tests.forbidAssertionReduction"],
    },
    {
      name: "a Python assert hidden in a docstring",
      policy: EDITABLE,
      changes: [
        edit(
          "tests/test_cart.py",
          PY_TEST,
          PY_TEST.replace("    assert total([1, 2]) == 3", '    """assert total([1, 2]) == 3"""'),
        ),
      ],
      violations: ["tests.forbidAssertionReduction"],
    },
  ],
};
