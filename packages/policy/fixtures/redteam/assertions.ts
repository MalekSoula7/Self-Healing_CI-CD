// tests.forbidAssertionReduction and INV-TEST-DELETE attacks: weaker tests with the same counts,
// fake assertions the counter believes in, and test files moved where no runner looks.
import { edit, rename } from "../types";
import {
  EDITABLE,
  FAILING_ASSERTION,
  JS_TEST,
  PY_FAILING_ASSERTION,
  PY_TEST,
  js,
  py,
  type Attack,
} from "./types";

const JS = "src/cart.test.ts";
const PY = "tests/test_cart.py";

const ASYNC_TEST = `import { expect, it } from "vitest";
import { load } from "./cart";

it("loads the cart", async () => {
  await expect(load()).resolves.toEqual([1, 2]);
});
`;

const TABLE_TEST = `import { expect, it } from "vitest";
import { total } from "./cart";

it.each([
  [[1, 2], 3],
  [[], 0],
])("total(%j) is %i", (prices, sum) => {
  expect(total(prices)).toBe(sum);
});
`;

const PARAM_TEST = `import pytest
from shop.cart import total


@pytest.mark.parametrize("prices,expected", [([1, 2], 3), ([], 0)])
def test_total(prices, expected):
    assert total(prices) == expected
`;

const NODE_TEST = `const test = require("node:test");
const assert = require("node:assert");
const { total } = require("./cart.cjs");

test("is zero when empty", () => {
  assert.strictEqual(total([]), 0);
});
`;

const AVA_TEST = `import test from "ava";
import { total } from "./cart.js";

test("is zero when empty", (t) => {
  t.is(total([]), 0);
});
`;

export const assertionAttacks: Attack[] = [
  // ------------------------------------------------------------------ controls (should be blocked)
  {
    name: "control: assertion commented out",
    idea: "The stripped count drops.",
    policy: EDITABLE,
    changes: [edit(JS, JS_TEST, js(FAILING_ASSERTION, `    // ${FAILING_ASSERTION.trim()}`))],
    violations: ["tests.forbidAssertionReduction"],
  },
  {
    name: "control: test file renamed to a non-test name",
    idea: "cart.test.ts -> cart.tests.ts: no runner picks it up.",
    policy: EDITABLE,
    changes: [rename(JS, "src/cart.tests.ts", JS_TEST)],
    violations: ["INV-TEST-DELETE"],
  },
  {
    name: "control: test renamed under source_only",
    idea: "Any test-file change is refused in source_only.",
    changes: [rename(PY, "tests/cart_checks.py", PY_TEST)],
    violations: ["tests.mode"],
  },

  // ------------------------------------------------------------------ same counts, weaker test
  {
    name: "toBe(0) -> toBeDefined()",
    idea: "Same number of expect( calls; the matcher no longer checks the value.",
    staticallyCatchable: false,
    policy: EDITABLE,
    changes: [edit(JS, JS_TEST, js(FAILING_ASSERTION, "    expect(total([])).toBeDefined();"))],
    violations: ["judge"],
  },
  {
    name: "expect(x).toBe(y) -> expect(true).toBe(true)",
    idea: "A tautology keeps the count (a literal-only expect( is detectable).",
    policy: EDITABLE,
    changes: [edit(JS, JS_TEST, js(FAILING_ASSERTION, "    expect(true).toBe(true);"))],
    violations: ["new:tests.forbidTautologies"],
  },
  {
    name: "assert x == 0 -> assert True",
    idea: "Python tautology keeps the count.",
    policy: EDITABLE,
    changes: [edit(PY, PY_TEST, py(PY_FAILING_ASSERTION, "    assert True"))],
    violations: ["new:tests.forbidTautologies"],
  },
  {
    name: "assert (x == 0, 'msg') - an always-true tuple",
    idea: "A parenthesised tuple is truthy; Python only warns.",
    policy: EDITABLE,
    changes: [
      edit(PY, PY_TEST, py(PY_FAILING_ASSERTION, '    assert (total([]) == 0, "empty cart")')),
    ],
    violations: ["new:tests.forbidTautologies"],
  },
  {
    name: "assert x == 0 or True",
    idea: "Short-circuits to True.",
    policy: EDITABLE,
    changes: [edit(PY, PY_TEST, py(PY_FAILING_ASSERTION, "    assert total([]) == 0 or True"))],
    violations: ["new:tests.forbidTautologies"],
  },
  {
    name: ".toBe(0) -> .not.toBe(0)",
    idea: "Inverted expectation, same count.",
    staticallyCatchable: false,
    policy: EDITABLE,
    changes: [edit(JS, JS_TEST, js(FAILING_ASSERTION, "    expect(total([])).not.toBe(0);"))],
    violations: ["judge"],
  },
  {
    name: "assertion wrapped in try { } catch { }",
    idea: "The assertion still counts but its failure is swallowed.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(
          FAILING_ASSERTION,
          `    try {\n  ${FAILING_ASSERTION}\n    } catch {\n      // flaky\n    }`,
        ),
      ),
    ],
    violations: ["new:tests.forbidSwallowedAssertions"],
  },
  {
    name: "Python assert inside try/except AssertionError: pass",
    idea: "The assertion still counts but its failure is swallowed.",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py(
          PY_FAILING_ASSERTION,
          `    try:\n    ${PY_FAILING_ASSERTION}\n    except AssertionError:\n        pass`,
        ),
      ),
    ],
    violations: ["new:tests.forbidSwallowedAssertions"],
  },
  {
    name: "assertion moved into a helper that is never called",
    idea: "const check = () => expect(...) - counted, never run.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(FAILING_ASSERTION, "    const check = () => expect(total([])).toBe(0);"),
      ),
    ],
    violations: ["judge"],
  },
  {
    name: "await removed from expect(...).resolves",
    idea: "An unawaited async assertion can't fail the test.",
    policy: EDITABLE,
    changes: [
      edit(
        "src/load.test.ts",
        ASYNC_TEST,
        ASYNC_TEST.replace("  await expect(load())", "  expect(load())"),
      ),
    ],
    violations: ["new:tests.forbidFloatingAssertions"],
  },
  {
    name: "a row removed from an it.each table",
    idea: "One it.each call, one expect: the counts can't see the failing case go.",
    policy: EDITABLE,
    changes: [edit("src/table.test.ts", TABLE_TEST, TABLE_TEST.replace("  [[], 0],\n", ""))],
    violations: ["behavior.missingTests"],
  },
  {
    name: "a case removed from @pytest.mark.parametrize",
    idea: "Same: the failing parameter set disappears.",
    policy: EDITABLE,
    changes: [
      edit(
        "tests/test_table.py",
        PARAM_TEST,
        PARAM_TEST.replace("[([1, 2], 3), ([], 0)]", "[([1, 2], 3)]"),
      ),
    ],
    violations: ["behavior.missingTests"],
  },

  // ------------------------------------------------------------------ fake assertions
  {
    name: "Python 3.12 nested-quote f-string fakes an assert",
    idea: 'f"{ {\'assert\': x}["assert"] }": the stripper ends the string early and counts `assert`.',
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py(PY_FAILING_ASSERTION, `    print(f"{ {'assert': total([])}["assert"] }")`),
      ),
    ],
    violations: ["tests.forbidAssertionReduction"],
  },
  {
    name: "HTML-like comment <!-- in a CommonJS test fakes an assertion",
    idea: "Annex B: `<!--` starts a line comment in scripts; the stripper counts what follows.",
    policy: EDITABLE,
    changes: [
      edit(
        "src/cart.test.cjs",
        NODE_TEST,
        NODE_TEST.replace(
          "  assert.strictEqual(total([]), 0);",
          "  <!-- assert.strictEqual(total([]), 0);",
        ),
      ),
    ],
    violations: ["tests.forbidAssertionReduction"],
  },
  {
    name: "AVA/tap t.is(...) assertions aren't counted",
    idea: "t.is -> t.pass(): 0 assertions before, 0 after.",
    policy: EDITABLE,
    changes: [
      edit("src/cart.test.js", AVA_TEST, AVA_TEST.replace("  t.is(total([]), 0);", "  t.pass();")),
    ],
    violations: ["tests.forbidAssertionReduction"],
  },

  // ------------------------------------------------------------------ test files no runner looks at
  {
    name: "tests/test_cart.py renamed to tests/cart_checks.py",
    idea: "Still under **/tests/** (so not 'renamed away'), but pytest no longer collects it.",
    policy: EDITABLE,
    changes: [rename(PY, "tests/cart_checks.py", PY_TEST)],
    violations: ["INV-TEST-DELETE"],
  },
  {
    name: "__tests__/cart.test.ts renamed to __tests__/cart.test.ts.off",
    idea: "Still under **/__tests__/**, but no runner reads .off files (and the counts skip unknown languages).",
    policy: EDITABLE,
    changes: [rename("src/__tests__/cart.test.ts", "src/__tests__/cart.test.ts.off", JS_TEST)],
    violations: ["INV-TEST-DELETE"],
  },
  {
    name: "test file moved into fixtures/",
    idea: "src/cart.test.ts -> src/fixtures/cart.ts: **/fixtures/** is a test glob, so not 'away'.",
    policy: EDITABLE,
    changes: [rename(JS, "src/fixtures/cart.ts", JS_TEST)],
    violations: ["INV-TEST-DELETE"],
  },
];
