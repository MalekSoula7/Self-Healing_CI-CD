// Rules added at CHECKPOINT 3 (Malek, from the P3.6 red team): tricks that make a failing test
// pass without fixing anything, checked on added lines. Tautological, swallowed and floating
// assertions (tests.forbidAssertionReduction); retries, test detection and test-framework patching
// (tests.forbidSkips); swallowed errors, type escapes and warning filters (suppressions.forbid).
import type { PolicyLayer } from "../src/index";
import { add, edit, type FixtureFamily } from "./types";

const EDITABLE: PolicyLayer = { tests: { mode: "may_edit_tests" } };

const JS_TEST = `import { expect, it } from "vitest";
import { total } from "./cart";

it("is zero when empty", async () => {
  expect(total([])).toBe(0);
});
`;

const withJs = (line: string) =>
  edit("src/cart.test.ts", JS_TEST, JS_TEST.replace("  expect(total([])).toBe(0);", line));

const PY_TEST = `from shop.cart import total


def test_zero():
    assert total([]) == 0
`;

const withPy = (lines: string) =>
  edit("tests/test_cart.py", PY_TEST, PY_TEST.replace("    assert total([]) == 0", lines));

const SOURCE = "export function total(prices: number[]): number {\n  return prices.length;\n}\n";
const withSource = (line: string) =>
  edit(
    "src/cart.ts",
    SOURCE,
    SOURCE.replace("  return prices.length;", `${line}\n  return prices.length;`),
  );

const PY_SOURCE = "def total(prices):\n    return len(prices)\n";
const withPySource = (lines: string) =>
  edit(
    "shop/cart.py",
    PY_SOURCE,
    PY_SOURCE.replace("    return len(prices)", `${lines}\n    return len(prices)`),
  );

export const heuristics: FixtureFamily = {
  allowed: [
    {
      name: "real assertions, awaited promises and a caught error that is checked",
      policy: EDITABLE,
      changes: [
        withJs(
          "  expect(total([])).toBe(0);\n  await expect(Promise.resolve(total([]))).resolves.toBe(0);\n" +
            "  try {\n    total(null as never);\n  } catch (error) {\n    expect(error).toBeInstanceOf(TypeError);\n  }",
        ),
      ],
      violations: [],
    },
    {
      name: "a returned .rejects and an expect on a variable",
      policy: EDITABLE,
      changes: [
        withJs(
          "  const empty = total([]);\n  expect(empty).toBe(0);\n  return expect(Promise.reject(new Error())).rejects.toThrow();",
        ),
      ],
      violations: [],
    },
    {
      name: "Python asserts on values, and pytest.raises",
      policy: EDITABLE,
      changes: [
        withPy(
          "    assert total([]) == 0\n    assert total([1]) or total([2])\n    with pytest.raises(TypeError):\n        total(None)",
        ),
      ],
      violations: [],
    },
    {
      name: "a catch that handles the error, and an except that re-raises",
      changes: [
        withSource(
          '  try {\n    JSON.parse("[]");\n  } catch (error) {\n    throw new Error("bad", { cause: error });\n  }',
        ),
        withPySource(
          '    try:\n        len(prices)\n    except TypeError:\n        raise ValueError("prices")',
        ),
      ],
      violations: [],
    },
    {
      name: "words that only look like the tricks",
      changes: [
        withSource(
          "  const anyPrice = prices.some((price) => price > 0); // retry later; as any reader knows",
        ),
      ],
      violations: [],
    },
    {
      name: "a long line in a lock-step table stays under the size limit",
      changes: [add("src/table.ts", `export const T = [${"1, ".repeat(60)}];\n`)],
      violations: [],
    },
    {
      name: "a docstring without examples",
      changes: [
        edit(
          "shop/cart.py",
          PY_SOURCE,
          `def total(prices):\n    """Sum of prices."""\n    return len(prices)\n`,
        ),
      ],
      violations: [],
    },
  ],
  forbidden: [
    {
      name: "tautological expects",
      policy: EDITABLE,
      changes: [withJs("  expect(true).toBe(true);\n  expect(1).toBeTruthy();")],
      violations: ["tests.forbidAssertionReduction", "tests.forbidAssertionReduction"],
    },
    {
      name: "tautological Python asserts",
      policy: EDITABLE,
      changes: [
        withPy(
          '    assert True\n    assert (total([]) == 0, "zero")\n    assert total([]) == 0 or True',
        ),
      ],
      violations: [
        "tests.forbidAssertionReduction",
        "tests.forbidAssertionReduction",
        "tests.forbidAssertionReduction",
      ],
    },
    {
      name: "an assertion swallowed by an empty catch",
      policy: EDITABLE,
      changes: [withJs("  try {\n    expect(total([])).toBe(0);\n  } catch {}")],
      violations: ["tests.forbidAssertionReduction"],
    },
    {
      name: "a Python assertion swallowed by except AssertionError",
      policy: EDITABLE,
      changes: [
        withPy("    try:\n        assert total([]) == 0\n    except AssertionError:\n        pass"),
      ],
      violations: ["tests.forbidAssertionReduction"],
    },
    {
      name: "an expect(...).resolves left floating",
      policy: EDITABLE,
      changes: [withJs("  expect(Promise.resolve(total([]))).resolves.toBe(0);")],
      violations: ["tests.forbidAssertionReduction"],
    },
    {
      name: "retries in a test file",
      policy: EDITABLE,
      changes: [withJs("  vi.retryTimes(3);\n  expect(total([])).toBe(0);")],
      violations: ["tests.forbidSkips"],
    },
    {
      name: "a retry option and a flaky marker",
      policy: EDITABLE,
      changes: [
        edit(
          "src/cart.test.ts",
          JS_TEST,
          JS_TEST.replace("async () => {", "{ retry: 3 }, async () => {"),
        ),
        edit(
          "tests/test_cart.py",
          PY_TEST,
          PY_TEST.replace("def test_zero", "@pytest.mark.flaky(reruns=3)\ndef test_zero"),
        ),
      ],
      violations: ["tests.forbidSkips", "tests.forbidSkips"],
    },
    {
      name: "source that detects the test runner",
      changes: [
        withSource("  if (process.env.VITEST) return 0;"),
        withPySource('    if "pytest" in sys.modules:\n        return 0'),
      ],
      violations: ["tests.forbidSkips", "tests.forbidSkips"],
    },
    {
      name: "source that patches the test framework",
      changes: [withPySource("    unittest.TestCase.assertEqual = lambda *args: None")],
      violations: ["tests.forbidSkips"],
    },
    {
      name: "a pytest hook in a source module",
      changes: [add("shop/plugin.py", "def pytest_runtest_call(item):\n    pass\n")],
      violations: ["tests.forbidSkips"],
    },
    {
      name: "an empty catch and except: pass in source",
      changes: [
        withSource('  try {\n    JSON.parse("[");\n  } catch {}'),
        withPySource("    try:\n        len(prices)\n    except Exception:\n        pass"),
      ],
      violations: ["suppressions.forbid", "suppressions.forbid"],
    },
    {
      name: "type escapes",
      changes: [
        withSource("  const list = prices as any;\n  const other = list as unknown as string;"),
      ],
      violations: ["suppressions.forbid", "suppressions.forbid"],
    },
    {
      name: "warnings silenced",
      changes: [withPySource('    warnings.filterwarnings("ignore")')],
      violations: ["suppressions.forbid"],
    },
    {
      name: "400 statements on one line count as many lines",
      changes: [add("src/blob.ts", `${"total([]);".repeat(400)}\n`)],
      violations: ["limits.maxLinesChanged"],
    },
    {
      name: "a doctest's expected output changed (source_only)",
      changes: [
        edit(
          "shop/cart.py",
          'def total(prices):\n    """\n    >>> total([1, 2])\n    2\n    """\n    return len(prices)\n',
          'def total(prices):\n    """\n    >>> total([1, 2])\n    3\n    """\n    return len(prices)\n',
        ),
      ],
      violations: ["tests.mode"],
    },
  ],
};
