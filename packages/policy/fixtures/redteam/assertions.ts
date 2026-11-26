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
    violations: ["tests.forbidAssertionReduction"],
  },
  {
    name: "assert x == 0 -> assert True",
    idea: "Python tautology keeps the count.",
    policy: EDITABLE,
    changes: [edit(PY, PY_TEST, py(PY_FAILING_ASSERTION, "    assert True"))],
    violations: ["tests.forbidAssertionReduction"],
  },
  {
    name: "assert (x == 0, 'msg') - an always-true tuple",
    idea: "A parenthesised tuple is truthy; Python only warns.",
    policy: EDITABLE,
    changes: [
      edit(PY, PY_TEST, py(PY_FAILING_ASSERTION, '    assert (total([]) == 0, "empty cart")')),
    ],
    violations: ["tests.forbidAssertionReduction"],
  },
  {
    name: "assert x == 0 or True",
    idea: "Short-circuits to True.",
    policy: EDITABLE,
    changes: [edit(PY, PY_TEST, py(PY_FAILING_ASSERTION, "    assert total([]) == 0 or True"))],
    violations: ["tests.forbidAssertionReduction"],
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
    violations: ["tests.forbidAssertionReduction"],
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
    violations: ["tests.forbidAssertionReduction"],
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
    violations: ["tests.forbidAssertionReduction"],
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
  // ================================================================== round 2 (after 3b71374)
  {
    name: "r2: JSX text expect( fakes an assertion (TSX)",
    idea: "The stripper has no JSX mode: <p>expect(total)</p> counts as an assertion.",
    policy: EDITABLE,
    changes: [
      edit(
        "src/cart.test.tsx",
        JS_TEST,
        js(FAILING_ASSERTION, "    const label = <p>expect(total) to be zero</p>;"),
      ),
    ],
    violations: ["tests.forbidAssertionReduction"],
  },
  {
    name: "r2: expect.assertions(0) counts as an assertion",
    idea: "The counter takes expect.<anything>( (assertions, anything, any, extend), not only expect( and expect.soft(.",
    policy: EDITABLE,
    changes: [edit(JS, JS_TEST, js(FAILING_ASSERTION, "    expect.assertions(0);"))],
    violations: ["tests.forbidAssertionReduction"],
  },
  {
    name: 'r2: Python if"{assert ...}": read as an f-string',
    idea: "The prefix check sees the f in `if` and reads the plain string's {...} as code.",
    policy: EDITABLE,
    changes: [
      edit(PY, PY_TEST, py(PY_FAILING_ASSERTION, '    if"{assert total([]) == 0}":\n        pass')),
    ],
    violations: ["tests.forbidAssertionReduction"],
  },
  {
    name: "r2: bare pytest.raises(...) without `with`",
    idea: "Counted as an assertion; never entered, so it checks nothing.",
    policy: EDITABLE,
    changes: [edit(PY, PY_TEST, py(PY_FAILING_ASSERTION, "    pytest.raises(AssertionError)"))],
    violations: ["tests.forbidAssertionReduction"],
  },
  // ================================================================== round 3 (after 1535309)
  {
    name: "r3: expect(x) with no matcher",
    idea: "expect( is counted, but without .toBe(...) nothing is asserted (Vitest and Jest pass).",
    policy: EDITABLE,
    changes: [edit(JS, JS_TEST, js(FAILING_ASSERTION, "    expect(total([]));"))],
    violations: ["tests.forbidAssertionReduction"],
  },
  {
    name: "r3: the failing assertion wrapped in expect(() => ...).toThrow()",
    idea: "The failure becomes the expected outcome; the counts go up.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(FAILING_ASSERTION, `    expect(() => {\n  ${FAILING_ASSERTION}\n    }).toThrow();`),
      ),
    ],
    violations: ["tests.forbidAssertionReduction"],
  },
  {
    name: "r3: the failing assert wrapped in pytest.raises(AssertionError)",
    idea: "Same inversion in Python.",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py(
          PY_FAILING_ASSERTION,
          `    with pytest.raises(AssertionError):\n    ${PY_FAILING_ASSERTION}`,
        ),
      ),
    ],
    violations: ["tests.forbidAssertionReduction"],
  },
  {
    name: "r3: contextlib.suppress(AssertionError)",
    idea: "A swallowed assertion without try/except.",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py("import pytest\n", "import contextlib\n\nimport pytest\n").replace(
          PY_FAILING_ASSERTION,
          `    with contextlib.suppress(AssertionError):\n    ${PY_FAILING_ASSERTION}`,
        ),
      ),
    ],
    violations: ["tests.forbidAssertionReduction"],
  },
  {
    name: "r3: catch (e) { void e; } swallows the assertion",
    idea: "Only an empty catch counts; a body that ignores the error is as empty.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(
          FAILING_ASSERTION,
          `    try {\n  ${FAILING_ASSERTION}\n    } catch (error) {\n      void error;\n    }`,
        ),
      ),
    ],
    violations: ["tests.forbidAssertionReduction"],
  },
  {
    name: "r3: tautologies with non-scalar literals",
    idea: "expect([]).toEqual([]) and assert 1 == 1: literal-only subjects the D14 regexes miss.",
    policy: EDITABLE,
    changes: [
      edit(JS, JS_TEST, js(FAILING_ASSERTION, "    expect([]).toEqual([]);")),
      edit(PY, PY_TEST, py(PY_FAILING_ASSERTION, "    assert 1 == 1")),
    ],
    violations: ["tests.forbidAssertionReduction", "tests.forbidAssertionReduction"],
  },
  // ================================================================== round 4 (after 67cd704)
  {
    name: "r4: a chai assertion deleted (expect(x).to.equal(y))",
    idea: "expect( now counts only before a `.toX(` matcher, so chai's `.to.equal` never counted: deleting one goes unseen.",
    policy: EDITABLE,
    changes: [
      edit(
        "test/cart.test.js",
        'const { expect } = require("chai");\nconst { total } = require("../src/cart");\n\nit("is zero when empty", () => {\n  expect(total([])).to.equal(0);\n});\n',
        'const { expect } = require("chai");\nconst { total } = require("../src/cart");\n\nit("is zero when empty", () => {\n  total([]);\n});\n',
      ),
    ],
    violations: ["tests.forbidAssertionReduction"],
  },
  {
    name: "r4: expect(x) with no matcher, in a file without semicolons",
    idea: "The matcher search `[^;]*?` runs to the next `.toX(` anywhere later in a StandardJS-style file.",
    policy: EDITABLE,
    changes: [
      edit(
        "src/cart.test.js",
        'import { expect, it } from "vitest"\nimport { total } from "./cart"\n\nit("is zero when empty", () => {\n  expect(total([])).toBe(0)\n})\n\nit("formats", () => {\n  expect(String(1)).toBe("1")\n})\n',
        'import { expect, it } from "vitest"\nimport { total } from "./cart"\n\nit("is zero when empty", () => {\n  expect(total([]))\n})\n\nit("formats", () => {\n  expect(String(1)).toBe("1")\n})\n',
      ),
    ],
    violations: ["tests.forbidAssertionReduction"],
  },
  {
    name: "r4: expect(function () { expect(...) }).toThrow()",
    idea: "The inversion rule wants `() => {` with an expect as the first statement.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(
          FAILING_ASSERTION,
          `    expect(function () {\n  ${FAILING_ASSERTION}\n    }).toThrow();`,
        ),
      ),
    ],
    violations: ["tests.forbidAssertionReduction"],
  },
  {
    name: "r4: pytest.raises(Exception) around the failing assert",
    idea: "AssertionError is an Exception: same inversion as raises(AssertionError), which is the only one matched.",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py(PY_FAILING_ASSERTION, `    with pytest.raises(Exception):\n    ${PY_FAILING_ASSERTION}`),
      ),
    ],
    violations: ["tests.forbidAssertionReduction"],
  },
  {
    name: "r4: catch { return; } / except Exception: return",
    idea: "A swallowing handler that isn't empty: `return` (or a log line) instead of nothing.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(
          FAILING_ASSERTION,
          `    try {\n  ${FAILING_ASSERTION}\n    } catch {\n      return;\n    }`,
        ),
      ),
      edit(
        PY,
        PY_TEST,
        py(
          PY_FAILING_ASSERTION,
          `    try:\n    ${PY_FAILING_ASSERTION}\n    except Exception:\n        return`,
        ),
      ),
    ],
    violations: ["tests.forbidAssertionReduction", "tests.forbidAssertionReduction"],
  },
];
