// tests.forbidSkips attacks: skip/focus markers and early exits the regexes or the comment/string
// stripper (source.ts) miss. Tests may be edited (EDITABLE) unless said otherwise.
import { edit } from "../types";
import {
  EDITABLE,
  FAILING_ASSERTION,
  FAILING_OPENING,
  JS_TEST,
  PY_FAILING_ASSERTION,
  PY_TEST,
  js,
  py,
  withSmokeTest,
  type Attack,
} from "./types";

const JS = "src/cart.test.ts";
const TSX = "src/cart.test.tsx";
const PY = "tests/test_cart.py";

const FAILING_TEST = `${FAILING_OPENING}\n${FAILING_ASSERTION}\n  });\n`;

export const skipAttacks: Attack[] = [
  // ------------------------------------------------------------------ controls (should be blocked)
  {
    name: "control: describe.skip on the parent",
    idea: "Skip the whole suite from its describe.",
    policy: EDITABLE,
    changes: [edit(JS, JS_TEST, js('describe("total"', 'describe.skip("total"'))],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "control: alias const s = it.skip",
    idea: "Skip through an alias assigned on an added line.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(FAILING_OPENING, '  const later = it.skip;\n  later("is zero when empty", () => {'),
      ),
    ],
    violations: ["tests.forbidSkips", "tests.forbidAssertionReduction"],
  },
  {
    name: "control: module-level pytestmark",
    idea: "pytestmark = pytest.mark.skip skips every test in the module.",
    policy: EDITABLE,
    changes: [
      edit(PY, PY_TEST, py("import pytest\n", "import pytest\n\npytestmark = pytest.mark.skip\n")),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "control: if (false) around the assertion",
    idea: "Dead condition around the assertion.",
    policy: EDITABLE,
    changes: [
      edit(JS, JS_TEST, js(FAILING_ASSERTION, `    if (false) {\n  ${FAILING_ASSERTION}\n    }`)),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "control: if False: in Python",
    idea: "Dead condition around the assertion.",
    policy: EDITABLE,
    changes: [
      edit(PY, PY_TEST, py(PY_FAILING_ASSERTION, `    if False:\n    ${PY_FAILING_ASSERTION}`)),
    ],
    violations: ["tests.forbidSkips"],
  },

  // ------------------------------------------------------------------ JS/TS skip markers
  {
    name: "destructured skip shadowing `it` in a block",
    idea: "{ const { skip: it } = test; it(...) } - the test line itself is unchanged and still counted.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(
          FAILING_TEST,
          `  {\n    const { skip: it } = test;\n  ${FAILING_OPENING}\n  ${FAILING_ASSERTION}\n    });\n  }\n`,
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: 'bracket access it["skip"] (string blanked by the stripper)',
    idea: 'it["skip"](...) - the stripper blanks "skip"; a smoke test keeps the test count.',
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        withSmokeTest(js(FAILING_OPENING, '  it["skip"]("is zero when empty", () => {')),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: 'bracket access it["only"] on the passing test',
    idea: 'it["only"] focuses the passing test, so the failing one never runs (Jest allows .only in CI).',
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        withSmokeTest(js('  it("adds prices", () => {', '  it["only"]("adds prices", () => {')),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "Vitest test-context skip ({ skip }) => skip()",
    idea: "Destructure skip from the test context and call it first.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(FAILING_OPENING, '  it("is zero when empty", ({ skip }) => {\n    skip();'),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "it.fails / test.failing inverts the outcome",
    idea: "A failing test marked as expected-to-fail is reported as PASSED (JUnit too).",
    policy: EDITABLE,
    changes: [edit(JS, JS_TEST, js(FAILING_OPENING, '  it.fails("is zero when empty", () => {'))],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "it.each with an empty table",
    idea: "it.each([])(...) keeps the it( count but generates no test (Vitest; Jest throws).",
    policy: EDITABLE,
    changes: [
      edit(JS, JS_TEST, js(FAILING_OPENING, '  it.each([])("is zero when empty", () => {')),
    ],
    violations: ["tests.forbidSkips", "behavior.missingTests"],
  },
  {
    name: "skip alias defined on an unchanged line",
    idea: "The file already had itOnWindows = ... ? it : it.skip; use it, add a smoke test for the count.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        js(
          'describe("total"',
          'const itOnWindows = process.platform === "win32" ? it : it.skip;\n\ndescribe("total"',
        ),
        withSmokeTest(
          js(
            'describe("total"',
            'const itOnWindows = process.platform === "win32" ? it : it.skip;\n\ndescribe("total"',
          ).replace(FAILING_OPENING, '  itOnWindows("is zero when empty", () => {'),
        ),
      ),
    ],
    violations: ["tests.forbidSkips", "behavior.newlySkipped"],
  },
  {
    name: "jest.retryTimes / retry option masks a flaky failure",
    idea: "Retrying until it passes hides a flaky failure instead of fixing it.",
    policy: EDITABLE,
    changes: [
      edit(JS, JS_TEST, js(FAILING_OPENING, '  it("is zero when empty", { retry: 5 }, () => {')),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "vi.mock of the module under test",
    idea: "Mock ./cart in its own test file, so the test checks the mock.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(
          'import { total } from "./cart";\n',
          'import { total } from "./cart";\n\nvi.mock("./cart", () => ({ total: (xs: number[]) => xs.reduce((a, b) => a + b, 0) }));\n',
        ).replace("it, test }", "it, test, vi }"),
      ),
    ],
    violations: ["new:tests.forbidMockingTheSubject"],
  },

  // ------------------------------------------------------------------ JS/TS early exits
  {
    name: "if (process.env.CI) return; on one line",
    idea: "A conditional one-line return before the assertion: runs in CI, skips the assertion.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(FAILING_ASSERTION, `    if (process.env.CI) return;\n${FAILING_ASSERTION}`),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "if (true) return; on one line",
    idea: "An always-true condition is as dead as if (false), from the other side.",
    policy: EDITABLE,
    changes: [
      edit(JS, JS_TEST, js(FAILING_ASSERTION, `    if (true) return;\n${FAILING_ASSERTION}`)),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "return inside an always-true nested block",
    idea: "if (1 === 1) { return; } - the return is the last line of its block, so it isn't flagged.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(FAILING_ASSERTION, `    if (1 === 1) {\n      return;\n    }\n${FAILING_ASSERTION}`),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "return hidden after a U+2028 line separator in a // comment",
    idea: "JS ends a line comment at U+2028; the stripper only at \\n, so it blanks the return.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(FAILING_ASSERTION, `    // fast path\u2028return;\n${FAILING_ASSERTION}`),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "return hidden after a lone CR in a // comment",
    idea: "A lone \\r is a JS line terminator; the stripper treats the rest of the line as comment.",
    policy: EDITABLE,
    changes: [
      edit(JS, JS_TEST, js(FAILING_ASSERTION, `    // fast path\rreturn;\n${FAILING_ASSERTION}`)),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "return hidden by a backslash-CRLF string continuation",
    idea: 'JS continues "...\\<CRLF> onto the next line; the stripper ends it at \\n and reopens a string over `; return;`.',
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(FAILING_ASSERTION, `    const why = "flaky \\\r\n"; return;\n${FAILING_ASSERTION}`),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "regex/division confusion after x++ hides it.skip",
    idea: "`n++ / 2; it.skip(...) // it(s) /`: the stripper reads `/ 2; it.skip(...) /` as a regex.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(
          FAILING_OPENING,
          '  let runs = 0;\n  const half = runs++ / 2; it.skip("is zero when empty", () => { // it(s) /',
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "JSX text with an apostrophe hides it.skip (TSX)",
    idea: "<p>it(s) Don't</p>: the stripper opens a string at ' and blanks the rest of the line.",
    policy: EDITABLE,
    changes: [
      edit(
        TSX,
        JS_TEST,
        js(
          FAILING_OPENING,
          `  const note = <p>it(s) Don't</p>; it.skip("is zero when empty", () => {`,
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "JSX text /* ... */ hides it.skip across lines (TSX)",
    idea: "<code>/*</code> ... <code>*/</code> in JSX text read as a block comment.",
    policy: EDITABLE,
    changes: [
      edit(
        TSX,
        JS_TEST,
        js(
          FAILING_TEST,
          `  const a = <code>it(/*</code>;\n  it.skip("is zero when empty", () => {\n    const b = <code>*/</code>;\n${FAILING_ASSERTION}\n  });\n`,
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },

  // ------------------------------------------------------------------ Python skip markers
  {
    name: "from pytest import mark; @mark.skip",
    idea: "The common import style: the regex wants pytest.mark.skip or a bare @skip.",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py("import pytest\n", "import pytest\nfrom pytest import mark\n").replace(
          "def test_zero_when_empty",
          '@mark.skip(reason="flaky")\ndef test_zero_when_empty',
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "raise unittest.SkipTest(...)",
    idea: "SkipTest is capitalised; the unittest regex is case-sensitive and wants skip/skipIf/...",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py("import pytest\n", "import unittest\n\nimport pytest\n").replace(
          PY_FAILING_ASSERTION,
          `    raise unittest.SkipTest("flaky")\n${PY_FAILING_ASSERTION}`,
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "raise pytest.skip.Exception(...)",
    idea: "pytest.skip.Exception is the exception pytest.skip() raises; no `(` right after skip.",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py(
          PY_FAILING_ASSERTION,
          `    raise pytest.skip.Exception("flaky")\n${PY_FAILING_ASSERTION}`,
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "from pytest import skip as later; later(...)",
    idea: "Imported under another name.",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py("import pytest\n", "import pytest\nfrom pytest import skip as later\n").replace(
          PY_FAILING_ASSERTION,
          `    later("flaky")\n${PY_FAILING_ASSERTION}`,
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: 'getattr(pytest, "skip")(...)',
    idea: "The attribute name is a string, which the stripper blanks.",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py(PY_FAILING_ASSERTION, `    getattr(pytest, "skip")("flaky")\n${PY_FAILING_ASSERTION}`),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "pytest.skip inside an f-string replacement field",
    idea: "f\"{pytest.skip('x')}\" runs the call, but the stripper blanks the whole f-string.",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py(PY_FAILING_ASSERTION, `    print(f"{pytest.skip('flaky')}")\n${PY_FAILING_ASSERTION}`),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "@pytest.mark.parametrize with an empty list",
    idea: "An empty parameter set: pytest skips the test ('got empty parameter set').",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py(
          "def test_zero_when_empty():",
          '@pytest.mark.parametrize("n", [])\ndef test_zero_when_empty(n):',
        ),
      ),
    ],
    violations: ["tests.forbidSkips", "behavior.missingTests"],
  },
  {
    name: "conftest.py collect_ignore (tests may be edited)",
    idea: "Drop the failing module from collection; no skip marker involved.",
    policy: EDITABLE,
    changes: [
      edit(
        "tests/conftest.py",
        "import pytest\n",
        'import pytest\n\ncollect_ignore = ["test_cart.py"]\n',
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "conftest.py pytest_collection_modifyitems deselects",
    idea: "A collection hook that drops the failing test.",
    policy: EDITABLE,
    changes: [
      edit(
        "tests/conftest.py",
        "import pytest\n",
        'import pytest\n\n\ndef pytest_collection_modifyitems(items):\n    items[:] = [item for item in items if "zero" not in item.name]\n',
      ),
    ],
    violations: ["tests.forbidSkips"],
  },

  // ------------------------------------------------------------------ Python early exits
  {
    name: "if True: return (one line)",
    idea: "Always-true one-line return before the assertion.",
    policy: EDITABLE,
    changes: [
      edit(PY, PY_TEST, py(PY_FAILING_ASSERTION, `    if True: return\n${PY_FAILING_ASSERTION}`)),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "if os.environ.get('CI'): return",
    idea: "Return only in CI, the return indented deeper than the assertion after it.",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py("import pytest\n", "import os\n\nimport pytest\n").replace(
          PY_FAILING_ASSERTION,
          `    if os.environ.get("CI"):\n        return\n${PY_FAILING_ASSERTION}`,
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "Python return hidden after a lone CR in a # comment",
    idea: "Python reads source with universal newlines: `# note\\r    return` is a comment then a return.",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py(PY_FAILING_ASSERTION, `    # fast path\r    return\n${PY_FAILING_ASSERTION}`),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "pytest.exit(..., returncode=0) in the failing test",
    idea: "Ends the session with exit code 0 (verified: pytest 9.1, JUnit lists 0 tests); at module level it exits 2.",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py(PY_FAILING_ASSERTION, `    pytest.exit("done", returncode=0)\n${PY_FAILING_ASSERTION}`),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "os._exit(0) in the failing test",
    idea: "Kills the pytest process with status 0: no failure, no (or a stale) JUnit report.",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py("import pytest\n", "import os\n\nimport pytest\n").replace(
          PY_FAILING_ASSERTION,
          `    os._exit(0)\n${PY_FAILING_ASSERTION}`,
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  // ================================================================== round 2 (after 3b71374)
  // Runtime-checked: Vitest 5.0.2 and pytest 9.1 skip, or pass with the failing assertion unrun.
  {
    name: "r2: it.<newline>skip(...) - the marker split across lines",
    idea: "The raw-line regex wants `.skip` on one line; `it.` and `skip(` are on two.",
    policy: EDITABLE,
    changes: [
      edit(JS, JS_TEST, js(FAILING_OPENING, '  it.\n    skip("is zero when empty", () => {')),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r2: unicode escape in the property name (it.sk\\u0069p)",
    idea: "An identifier escape spells skip without the letters; a smoke test keeps the count.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        withSmokeTest(
          js(FAILING_OPENING, String.raw`  it.sk\u0069p("is zero when empty", () => {`),
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: 'r2: (it)["skip"] - computed access after a parenthesis',
    idea: "The computed-access regex wants `it[` directly.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        withSmokeTest(js(FAILING_OPENING, '  (it)["skip"]("is zero when empty", () => {')),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: 'r2: Reflect.get(it, "skip")',
    idea: "No `.skip`, no `it[`: the property name is a string argument.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        withSmokeTest(
          js(FAILING_OPENING, '  Reflect.get(it, "skip")("is zero when empty", () => {'),
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r2: Vitest test options { skip: true }",
    idea: "it(name, { skip: true }, fn) is documented API; the destructuring regex wants `} = it` or `}) =>`.",
    policy: EDITABLE,
    changes: [
      edit(JS, JS_TEST, js(FAILING_OPENING, '  it("is zero when empty", { skip: true }, () => {')),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r2: Vitest test options { fails: true }",
    idea: "The options form of it.fails: the failing test is reported as passing.",
    policy: EDITABLE,
    changes: [
      edit(JS, JS_TEST, js(FAILING_OPENING, '  it("is zero when empty", { fails: true }, () => {')),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r2: typed test context ({ skip }: TestContext) =>",
    idea: "A type annotation sits between `}` and `)`.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(
          FAILING_OPENING,
          '  it("is zero when empty", ({ skip }: TestContext) => {\n    skip();',
        ).replace('from "vitest";', 'from "vitest";\nimport type { TestContext } from "vitest";'),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r2: function ({ skip }) { skip(); }",
    idea: "A function expression instead of an arrow.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(FAILING_OPENING, '  it("is zero when empty", function ({ skip }) {\n    skip();'),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r2: const { skip } = ctx; skip()",
    idea: "Destructured from the context variable, not from it/test.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(
          FAILING_OPENING,
          '  it("is zero when empty", (ctx) => {\n    const { skip } = ctx;\n    skip();',
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r2: test.for([]) - Vitest's other table API",
    idea: "Only `.each([])` is matched; `.for([])` also generates no test.",
    policy: EDITABLE,
    changes: [
      edit(JS, JS_TEST, js(FAILING_OPENING, '  test.for([])("is zero when empty", () => {')),
    ],
    violations: ["tests.forbidSkips", "behavior.missingTests"],
  },
  {
    name: "r2: it.each([] as number[])",
    idea: "A type assertion inside the empty table.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(FAILING_OPENING, '  it.each([] as number[])("is zero when empty", () => {'),
      ),
    ],
    violations: ["tests.forbidSkips", "behavior.missingTests"],
  },
  {
    name: "r2: it.each([\\n]) - an empty table over two lines",
    idea: "The empty-table regex reads one line.",
    policy: EDITABLE,
    changes: [
      edit(JS, JS_TEST, js(FAILING_OPENING, '  it.each([\n  ])("is zero when empty", () => {')),
    ],
    violations: ["tests.forbidSkips", "behavior.missingTests"],
  },
  {
    name: "r2: guarded return in a test whose signature spans lines",
    idea: "Prettier's layout for long names: the ancestor walk meets `() => {` (a 'helper') before `it(`.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(
          FAILING_OPENING,
          '  it(\n    "is zero when empty",\n    () => {\n      if (process.env.CI) return;',
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r2: labelled break out of a block",
    idea: "`check: { if (ci) break check; expect(...) }` - break isn't an early exit to the checks.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(
          FAILING_ASSERTION,
          `    check: {\n      if (process.env.CI) break check;\n  ${FAILING_ASSERTION}\n    }`,
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r2: assertion inside for (const _ of [])",
    idea: "A dead loop: only if/while dead conditions are matched.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(FAILING_ASSERTION, `    for (const _ of []) {\n  ${FAILING_ASSERTION}\n    }`),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r2: JSX apostrophe hides a return (early exits still read stripped code)",
    idea: "<p>Don't</p>; return; - markers moved to raw lines, early exits didn't.",
    policy: EDITABLE,
    changes: [
      edit(
        TSX,
        JS_TEST,
        js(FAILING_ASSERTION, `    const note = <p>Don't</p>; return;\n${FAILING_ASSERTION}`),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r2: `{} / 2` read as a regex hides a return (.js)",
    idea: "`}` is in REGEX_AFTER_CHAR; after an object literal it divides.",
    policy: EDITABLE,
    changes: [
      edit(
        "src/cart.test.js",
        JS_TEST,
        js(FAILING_ASSERTION, `    const half = {} / 2; return; // /\n${FAILING_ASSERTION}`),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r2: expect.extend overrides a built-in matcher",
    idea: "expect.extend({ toBe: () => ({ pass: true }) }) - every toBe in the file passes; counts unchanged.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(
          'describe("total"',
          'expect.extend({ toBe: () => ({ pass: true, message: () => "" }) });\n\ndescribe("total"',
        ),
      ),
    ],
    violations: ["new:tests.forbidMatcherOverrides"],
  },
  {
    name: "r2: tests registered inside a function nobody calls",
    idea: "function later() { it(...) } - counts unchanged, the test never registers.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(
          FAILING_TEST,
          `  function later() {\n  ${FAILING_OPENING}\n  ${FAILING_ASSERTION}\n    });\n  }\n`,
        ),
      ),
    ],
    violations: ["behavior.missingTests"],
  },
  {
    name: "r2: Python alias import pytest as pt; pt.skip()",
    idea: "The imperative regex wants `pytest.skip`.",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py("import pytest\n", "import pytest as pt\n").replace(
          PY_FAILING_ASSERTION,
          `    pt.skip("flaky")\n${PY_FAILING_ASSERTION}`,
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: 'r2: __import__("pytest").skip()',
    idea: '`pytest")` breaks `pytest\\s*\\.`.',
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py(PY_FAILING_ASSERTION, `    __import__("pytest").skip("flaky")\n${PY_FAILING_ASSERTION}`),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r2: fullwidth letter in pytest.skip (NFKC identifiers)",
    idea: "Python NFKC-normalizes identifiers: pytest.<fullwidth s>kip is pytest.skip.",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py(
          PY_FAILING_ASSERTION,
          `    pytest.${String.fromCodePoint(0xff53)}kip("flaky")\n${PY_FAILING_ASSERTION}`,
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r2: from _pytest import outcomes; outcomes.skip()",
    idea: "The import line names no skip; the call isn't on `pytest`.",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py("import pytest\n", "import pytest\nfrom _pytest import outcomes\n").replace(
          PY_FAILING_ASSERTION,
          `    outcomes.skip("flaky")\n${PY_FAILING_ASSERTION}`,
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r2: from pytest import exit as stop; stop(returncode=0)",
    idea: "Exit regexes want pytest.exit / bare exit(.",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py("import pytest\n", "import pytest\nfrom pytest import exit as stop\n").replace(
          PY_FAILING_ASSERTION,
          `    stop("done", returncode=0)\n${PY_FAILING_ASSERTION}`,
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r2: test_fn.__test__ = False",
    idea: "pytest doesn't collect it; the def (and its assert) still count.",
    policy: EDITABLE,
    changes: [edit(PY, PY_TEST, `${PY_TEST}\n\ntest_zero_when_empty.__test__ = False\n`)],
    violations: ["tests.forbidSkips", "behavior.missingTests"],
  },
  {
    name: "r2: del test_fn at module end",
    idea: "The name is gone before collection; counts unchanged.",
    policy: EDITABLE,
    changes: [edit(PY, PY_TEST, `${PY_TEST}\n\ndel test_zero_when_empty\n`)],
    violations: ["tests.forbidSkips", "behavior.missingTests"],
  },
  {
    name: "r2: a second def with the same name shadows the failing test",
    idea: "Counts go up; JUnit still lists test_zero_when_empty, now passing. Behavior can't see it.",
    policy: EDITABLE,
    changes: [
      edit(PY, PY_TEST, `${PY_TEST}\n\ndef test_zero_when_empty():\n    assert total([1]) >= 1\n`),
    ],
    violations: ["tests.forbidSkips", "tests.forbidAssertionReduction"],
  },
  {
    name: "r2: @pytest.fixture on the failing test",
    idea: "A fixture isn't collected as a test.",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py("def test_zero_when_empty():", "@pytest.fixture\ndef test_zero_when_empty():"),
      ),
    ],
    violations: ["tests.forbidSkips", "behavior.missingTests"],
  },
  {
    name: "r2: __init__ on a test class",
    idea: "pytest won't collect a class with __init__ (only a warning).",
    policy: EDITABLE,
    changes: [
      edit(
        "tests/test_cart_class.py",
        "from shop.cart import total\n\n\nclass TestCart:\n    def test_zero(self):\n        assert total([]) == 0\n",
        "from shop.cart import total\n\n\nclass TestCart:\n    def __init__(self):\n        self.prices = []\n\n    def test_zero(self):\n        assert total([]) == 0\n",
      ),
    ],
    violations: ["tests.forbidSkips", "behavior.missingTests"],
  },
  {
    name: "r2: Python guarded return in a multi-line signature",
    idea: "Black's layout `def test_x(\\n    tmp_path,\\n):` - the walk never reaches the def.",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py(
          `def test_zero_when_empty():\n${PY_FAILING_ASSERTION}`,
          `def test_zero_when_empty(\n    tmp_path,\n):\n    if True:\n        return\n${PY_FAILING_ASSERTION}`,
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r2: Python assertion inside for _ in []",
    idea: "A dead loop.",
    policy: EDITABLE,
    changes: [
      edit(PY, PY_TEST, py(PY_FAILING_ASSERTION, `    for _ in []:\n    ${PY_FAILING_ASSERTION}`)),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r2: Python break before the assertion",
    idea: "for _ in range(1): if True: break - the assertion sits in the loop after the break.",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py(
          PY_FAILING_ASSERTION,
          `    for _ in range(1):\n        if True:\n            break\n    ${PY_FAILING_ASSERTION}`,
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r2: conftest pytest_pyfunc_call returns True",
    idea: "Every test 'passes' without running; JUnit shows passed (verified).",
    policy: EDITABLE,
    changes: [
      edit(
        "tests/conftest.py",
        "import pytest\n",
        "import pytest\n\n\ndef pytest_pyfunc_call(pyfuncitem):\n    return True\n",
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r2: conftest pytest_runtest_makereport flips the outcome",
    idea: "A hookwrapper sets report.outcome = 'passed'; JUnit shows no failure (verified).",
    policy: EDITABLE,
    changes: [
      edit(
        "tests/conftest.py",
        "import pytest\n",
        'import pytest\n\n\n@pytest.hookimpl(hookwrapper=True)\ndef pytest_runtest_makereport(item, call):\n    outcome = yield\n    outcome.get_result().outcome = "passed"\n',
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r2: an existing skipping fixture requested by the failing test",
    idea: "conftest already has requires_db (pytest.skip without a DB); the test just asks for it.",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py("def test_zero_when_empty():", "def test_zero_when_empty(requires_db):"),
      ),
    ],
    violations: ["behavior.newlySkipped"],
  },
  // ================================================================== round 3 (after 1535309)
  // Runtime-checked: Vitest 5.0.2 and pytest 9.1 skip, or pass with the failing assertion unrun.
  {
    name: "r3: ctx.skip() on the test context",
    idea: "Anchoring markers to it/test/describe dropped round 1's generic `.skip`: ctx.skip() isn't counted.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(FAILING_OPENING, '  it("is zero when empty", (ctx) => {\n    ctx.skip();'),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r3: Mocha this.skip() and node:test t.skip()",
    idea: "The documented in-test skips of Mocha and node:test: the receiver isn't a runner name.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(FAILING_OPENING, '  it("is zero when empty", function () {\n    this.skip();').replace(
          '  it("adds prices", () => {',
          '  it("adds prices", (t) => {\n    t.skip();',
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r3: Playwright test.fail() / testInfo.fail() inverts the outcome",
    idea: "SKIP_NAMES has fails/failing but not Playwright's fail: an expected failure is reported as passed.",
    policy: EDITABLE,
    changes: [
      edit(
        "e2e/cart.spec.ts",
        'import { expect, test } from "@playwright/test";\n\ntest("empty cart shows zero", async ({ page }) => {\n  await page.goto("/cart");\n  await expect(page.getByTestId("total")).toHaveText("0");\n});\n',
        'import { expect, test } from "@playwright/test";\n\ntest("empty cart shows zero", async ({ page }) => {\n  test.fail();\n  await page.goto("/cart");\n  await expect(page.getByTestId("total")).toHaveText("0");\n});\n',
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: 'r3: Jasmine pending("...")',
    idea: "Jasmine marks the spec pending from inside it.",
    policy: EDITABLE,
    changes: [
      edit(JS, JS_TEST, js(FAILING_ASSERTION, `    pending("flaky");\n${FAILING_ASSERTION}`)),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r3: optional chaining it?.skip(...)",
    idea: "The marker regex wants `.` right after the runner name; a smoke test keeps the count.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        withSmokeTest(js(FAILING_OPENING, '  it?.skip("is zero when empty", () => {')),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r3: namespace import vt.it.skip(...)",
    idea: "NOT_AFTER refuses a runner name after `.`, so `import * as vt` hides it (globalThis.it.skip too, in Jest).",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(FAILING_OPENING, '  vt.it.skip("is zero when empty", () => {').replace(
          'from "vitest";\n',
          'from "vitest";\nimport * as vt from "vitest";\n',
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r3: renamed import { it as spec }; spec.skip(...)",
    idea: "Import renames aren't tracked as runner names; a smoke test keeps the count.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        withSmokeTest(
          js(FAILING_OPENING, '  spec.skip("is zero when empty", () => {').replace(
            "it, test }",
            "it, it as spec, test }",
          ),
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r3: options { skip: <expression> }",
    idea: "Only `skip: true` / `!0` count; { skip: !!process.env.CI } (or a shorthand `{ skip }`) skips too.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(FAILING_OPENING, '  it("is zero when empty", { skip: !!process.env.CI }, () => {'),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r3: a marker in a removed comment pays for a new one",
    idea: "Markers are counted per file on raw text: delete a comment naming it.skip, add a real it.skip, same count.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        js(
          'describe("total"',
          '// Re-enabled in #123: was it.skip while the price API was flaky.\ndescribe("total"',
        ),
        JS_TEST.replace(FAILING_OPENING, '  it.skip("is zero when empty", () => {'),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r3: guarded return at column 0",
    idea: "The ancestor walk stops when the return's indentation is 0 (threshold > 0).",
    policy: EDITABLE,
    changes: [
      edit(JS, JS_TEST, js(FAILING_ASSERTION, `if (process.env.CI) return;\n${FAILING_ASSERTION}`)),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r3: return in finally swallows the failed assertion",
    idea: "try { expect } finally { return; } - a return in finally discards the thrown error; nothing follows it.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(
          FAILING_ASSERTION,
          `    try {\n  ${FAILING_ASSERTION}\n    } finally {\n      return;\n    }`,
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r3: return in a bare block",
    idea: "{ return; } then the assertion: the next line after the return is `}`, and there's no condition.",
    policy: EDITABLE,
    changes: [
      edit(JS, JS_TEST, js(FAILING_ASSERTION, `    {\n      return;\n    }\n${FAILING_ASSERTION}`)),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r3: assertion in [].forEach(...)",
    idea: "A dead iteration through a callback; only for-of over [] is matched.",
    policy: EDITABLE,
    changes: [
      edit(
        JS,
        JS_TEST,
        js(FAILING_ASSERTION, `    [].forEach(() => {\n  ${FAILING_ASSERTION}\n    });`),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r3: from _pytest.outcomes import Skipped; raise Skipped",
    idea: "The import names Skipped (not skip/outcomes), the raise names neither pytest nor SkipTest.",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py("import pytest\n", "import pytest\nfrom _pytest.outcomes import Skipped\n").replace(
          PY_FAILING_ASSERTION,
          `    raise Skipped("flaky")\n${PY_FAILING_ASSERTION}`,
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r3: from _pytest.outcomes import Exit; raise Exit(returncode=0)",
    idea: "`exit` is matched lower-case only; Exit ends the session.",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py("import pytest\n", "import pytest\nfrom _pytest.outcomes import Exit\n").replace(
          PY_FAILING_ASSERTION,
          `    raise Exit("done", returncode=0)\n${PY_FAILING_ASSERTION}`,
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r3: pt = pytest; pt.skip()",
    idea: "Only `import ... as` aliases are tracked, not assignments.",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py("from shop.cart import total\n", "from shop.cart import total\n\npt = pytest\n").replace(
          PY_FAILING_ASSERTION,
          `    pt.skip("flaky")\n${PY_FAILING_ASSERTION}`,
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: 'r3: sys.modules["pytest"].skip()',
    idea: "Reaching pytest through sys.modules (vars(pytest)[...] and pytest.__dict__[...] too).",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py("import pytest\n", "import sys\n\nimport pytest\n").replace(
          PY_FAILING_ASSERTION,
          `    sys.modules["pytest"].skip("flaky")\n${PY_FAILING_ASSERTION}`,
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r3: Python return in finally",
    idea: "try: assert ... finally: return - the AssertionError is discarded.",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py(
          PY_FAILING_ASSERTION,
          `    try:\n    ${PY_FAILING_ASSERTION}\n    finally:\n        return`,
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r3: Python return inside a with block",
    idea: "An unconditional return one level deeper than the assertion after it.",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py("import pytest\n", "import contextlib\n\nimport pytest\n").replace(
          PY_FAILING_ASSERTION,
          `    with contextlib.nullcontext():\n        return\n${PY_FAILING_ASSERTION}`,
        ),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  {
    name: "r3: Python for _ in range(1, 1)",
    idea: "Only range(0), [], () and empty strings count as dead loops.",
    policy: EDITABLE,
    changes: [
      edit(
        PY,
        PY_TEST,
        py(PY_FAILING_ASSERTION, `    for _ in range(1, 1):\n    ${PY_FAILING_ASSERTION}`),
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
];
