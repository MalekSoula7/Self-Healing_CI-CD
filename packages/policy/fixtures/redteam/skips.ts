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
    violations: ["new:tests.forbidRetries"],
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
];
