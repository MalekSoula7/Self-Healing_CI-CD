// Rules added at CHECKPOINT 3 (D14, from the P3.6 red team, SPEC §8.5): tricks that make a
// failing check pass without fixing anything, on added lines. Each is cheap and rare in real fixes.
// - Test files (tests.forbidAssertionReduction): tautological assertions, assertions swallowed by
//   an empty catch, `except AssertionError`, `pytest.raises(AssertionError)` or
//   `suppress(AssertionError)`, assertions inverted by `expect(() => { expect(...) }).toThrow()`,
//   `expect(...).resolves/.rejects` neither awaited nor returned. (tests.forbidSkips): retries.
// - Source files (tests.forbidSkips): code that detects the test runner or CI, or patches the test
//   framework. (suppressions.forbid): an empty `catch {}` / `except: pass`, `as any` /
//   `as unknown as` / `<any>`, warning filters.
import type { Change } from "../diff";
import { addedLines, at, languageOf, stripCode, type Language } from "../source";
import type { Check, CheckContext, Violation } from "./types";

type RuleId = "tests.forbidAssertionReduction" | "tests.forbidSkips" | "suppressions.forbid";

interface Rule {
  ruleId: RuleId;
  /** Matched on the stripped line (code only) or the raw line (strings and comments included). */
  on: "code" | "raw";
  /** A pattern, or a test for what a pattern can't say. */
  matches: RegExp | ((text: string) => boolean);
  message: string;
  hint: string;
}

const TAUTOLOGY = {
  ruleId: "tests.forbidAssertionReduction",
  on: "code",
  message: "asserts something that is always true.",
  hint: "Assert on the code under test's real result.",
} as const;

const RETRY = {
  ruleId: "tests.forbidSkips",
  on: "raw",
  message: "retries a test until it passes.",
  hint: "Fix the failure instead of retrying it.",
} as const;

const SWALLOWED = {
  ruleId: "tests.forbidAssertionReduction",
  on: "code",
  message: "catches or inverts failed assertions.",
  hint: "Let failed assertions fail the test.",
} as const;

// Literals as they look after stripping (string contents blanked).
const PY_LITERAL = String.raw`(-?\d+(\.\d+)?|True|False|None|"\s*"|'\s*'|\[\s*\]|\{\s*\}|\(\s*\))`;

/** `assert (x, "msg")`: one parenthesized group spanning the rest, with a top-level comma. */
function tupleAssert(code: string): boolean {
  const match = /^\s*assert\s*\(/.exec(code);
  if (match === null) return false;
  const rest = code.slice(match[0].length - 1).trimEnd();
  let depth = 0;
  let comma = false;
  for (let index = 0; index < rest.length; index += 1) {
    const char = at(rest, index);
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return comma && index === rest.length - 1;
    } else if (char === "," && depth === 1) comma = true;
  }
  return false;
}

const TEST_RULES: Record<Language, readonly Rule[]> = {
  js: [
    {
      ...TAUTOLOGY,
      // expect(true), expect(1), expect(null), expect(""), expect([]), expect({}): a literal subject.
      matches:
        /\bexpect\s*\(\s*(true|false|null|undefined|-?\d+(\.\d+)?|"\s*"|'\s*'|`\s*`|\[\s*\]|\{\s*\})\s*\)/,
    },
    { ...TAUTOLOGY, matches: /\bassert(\s*\.\s*ok)?\s*\(\s*(true|1)\s*[,)]/ },
    {
      ruleId: "tests.forbidAssertionReduction",
      on: "code",
      matches: /^\s*expect\b.*\.\s*(resolves|rejects)\b/,
      message: "leaves a .resolves/.rejects assertion floating: nothing waits for it.",
      hint: "await (or return) every expect(...).resolves / .rejects.",
    },
    // expect(() => { expect(...) }).toThrow(): the failing assertion's error becomes the pass.
    { ...SWALLOWED, matches: /\bexpect\s*\(\s*(async\s*)?\(\s*\)\s*=>\s*\{?\s*expect\s*\(/ },
    {
      ...RETRY,
      matches:
        /\b(jest|vi)\s*\.\s*retryTimes\s*\(\s*[1-9]|\bretry\s*:\s*[1-9]|\bretries\s*[:(]\s*[1-9]/,
    },
  ],
  python: [
    {
      ...TAUTOLOGY,
      matches: new RegExp(String.raw`^\s*assert\s+(True|1|not\s+False|"\s*"|'\s*')\s*(,|$)`),
    },
    {
      ...TAUTOLOGY,
      matches: new RegExp(
        String.raw`^\s*assert\s+${PY_LITERAL}\s*(==|!=|is|is\s+not|in|<|>|<=|>=)\s*${PY_LITERAL}\s*(,|$)`,
      ),
    },
    { ...TAUTOLOGY, matches: tupleAssert },
    { ...TAUTOLOGY, matches: /^\s*assert\b.*\bor\s+(True|1)\s*(,|$)/ },
    {
      ...SWALLOWED,
      matches:
        /^\s*except\s*\(?\s*AssertionError\b|\b(raises|suppress)\s*\(\s*([\w.]*\.)?AssertionError\b/,
    },
    { ...RETRY, matches: /@\s*(pytest\s*\.\s*mark\s*\.\s*)?(flaky|retry)\b|\breruns\s*=\s*[1-9]/ },
  ],
};

const TEST_DETECTION = {
  ruleId: "tests.forbidSkips",
  on: "raw",
  message: "detects the test runner or CI, so the code behaves differently under test.",
  hint: "Fix the code for every caller, not only when tests or CI run it.",
} as const;

const FRAMEWORK_PATCH = {
  ruleId: "tests.forbidSkips",
  on: "code",
  message: "changes the test framework from source code.",
  hint: "Leave the test framework alone; fix the code under test.",
} as const;

const SOURCE_RULES: Record<Language, readonly Rule[]> = {
  js: [
    {
      ...TEST_DETECTION,
      matches:
        /\b(VITEST|VITEST_WORKER_ID|JEST_WORKER_ID|JEST_WORKER|npm_lifecycle_event|__vitest_worker__)\b|import\.meta\.(vitest|env\.(MODE|VITEST))\b|process\.env\.CI\b|process\.env\[\s*["'`]CI["'`]\s*\]|\bNODE_ENV\b\s*[!=]==?\s*["'`]test["'`]|["'`]test["'`]\s*[!=]==?\s*[\w$.]*NODE_ENV\b|typeof\s+(it|describe|jest|vi|expect)\s*!==?\s*["']undefined["']/,
    },
    {
      ...FRAMEWORK_PATCH,
      matches:
        /\b(globalThis|global|window)\s*\.\s*(it|test|describe|expect|jest|vi)\s*=[^=]|\bObject\s*\.\s*assign\s*\(\s*(globalThis|global|window)\s*,/,
    },
    {
      ruleId: "suppressions.forbid",
      on: "code",
      matches: /\bas\s+any\b|\bas\s+unknown\s+as\b|<any>\s*[\w$([]/,
      message: "escapes the type checker (as any, as unknown as, <any>).",
      hint: "Fix the types instead of casting them away.",
    },
    {
      ruleId: "suppressions.forbid",
      on: "raw",
      matches:
        /\bprocess\s*\.\s*(noDeprecation|removeAllListeners\s*\(\s*["']warning|emitWarning\s*=[^=])/,
      message: "silences runtime warnings.",
      hint: "Fix what the warning reports instead of silencing it.",
    },
  ],
  python: [
    {
      ...TEST_DETECTION,
      matches:
        /\b(PYTEST_CURRENT_TEST|PYTEST_XDIST_WORKER|PYTEST_VERSION)\b|["']pytest["']\s+in\s+sys\s*\.\s*modules|sys\s*\.\s*modules\b.*["']pytest|\b_called_from_test\b|\b(environ(\s*\.\s*get)?\s*[[(]|getenv\s*\()\s*["']CI["']/,
    },
    {
      ...FRAMEWORK_PATCH,
      matches:
        /\bTestCase\s*\.\s*\w+\s*=[^=]|^\s*def\s+pytest_\w+\s*\(|\bsetattr\s*\(\s*([\w.]*\.)?TestCase\b/,
    },
    {
      ruleId: "suppressions.forbid",
      on: "raw",
      matches: /\bwarnings\s*\.\s*(filterwarnings|simplefilter)\s*\(\s*(action\s*=\s*)?["']ignore/,
      message: "silences warnings.",
      hint: "Fix what the warning reports instead of silencing it.",
    },
  ],
};

function matches(rule: Rule, text: string): boolean {
  return typeof rule.matches === "function" ? rule.matches(text) : rule.matches.test(text);
}

/**
 * An empty catch (or one that only discards the error: `void e;`), or an `except` of everything
 * (bare, Exception, BaseException) whose body is only `pass` / `...`, starting at `index`.
 * Catching a specific error and moving on (`except ImportError: pass`) is ordinary code.
 */
function swallows(lines: readonly string[], index: number, language: Language): boolean {
  const line = at(lines, index);
  const body = lines.slice(index + 1).filter((next) => next.trim() !== "");
  if (language === "js") {
    if (/\bcatch\s*(\([^)]*\))?\s*\{\s*(void\s+[\w$]+\s*;?\s*)?\}/.test(line)) return true;
    if (!/\bcatch\s*(\([^)]*\))?\s*\{\s*$/.test(line)) return false;
    const first = at(body, 0);
    return (
      /^\s*\}/.test(first) ||
      (/^\s*void\s+[\w$]+\s*;?\s*$/.test(first) && /^\s*\}/.test(at(body, 1)))
    );
  }
  if (!/^\s*except\s*(\(?\s*(Exception|BaseException)\b[^:]*)?:/.test(line)) return false;
  if (/:\s*(pass|\.\.\.)\s*$/.test(line)) return true;
  return /:\s*$/.test(line) && /^\s*(pass|\.\.\.)\s*$/.test(at(body, 0));
}

/** `expect(() => {` with an `expect(` as the callback's first statement, on the next line. */
function wrapsExpect(lines: readonly string[], index: number): boolean {
  if (!/\bexpect\s*\(\s*(async\s*)?\(\s*\)\s*=>\s*\{\s*$/.test(at(lines, index))) return false;
  const next = lines.slice(index + 1).find((line) => line.trim() !== "") ?? "";
  return /^\s*expect\s*\(/.test(next);
}

function violationsIn(change: Change, language: Language, isTest: boolean): Violation[] {
  const content = change.newContent ?? "";
  const raw = content.split("\n");
  const code = stripCode(content, language).split("\n");
  const rules = (isTest ? TEST_RULES : SOURCE_RULES)[language];
  const violations: Violation[] = [];
  const report = (line: number, ruleId: RuleId, message: string, hint: string) => {
    violations.push({
      ruleId,
      path: change.path,
      line,
      message: `${change.path}:${String(line)} ${message}`,
      hint,
    });
  };
  for (const { line } of addedLines(change)) {
    const text = { raw: at(raw, line - 1), code: at(code, line - 1) };
    const rule = rules.find((candidate) => matches(candidate, text[candidate.on]));
    if (rule !== undefined) {
      report(line, rule.ruleId, rule.message, rule.hint);
    } else if (isTest && language === "js" && wrapsExpect(code, line - 1)) {
      report(line, SWALLOWED.ruleId, SWALLOWED.message, SWALLOWED.hint);
    } else if (swallows(code, line - 1, language)) {
      if (isTest) {
        report(
          line,
          "tests.forbidAssertionReduction",
          "swallows errors, failed assertions included.",
          "Let failed assertions fail the test.",
        );
      } else {
        report(
          line,
          "suppressions.forbid",
          "swallows errors without handling them.",
          "Handle the error, or let it propagate; don't hide it.",
        );
      }
    }
  }
  return violations;
}

const ENABLED: Record<RuleId, (context: CheckContext) => boolean> = {
  "tests.forbidAssertionReduction": ({ policy }) => policy.tests.forbidAssertionReduction,
  "tests.forbidSkips": ({ policy }) => policy.tests.forbidSkips,
  "suppressions.forbid": ({ policy }) => policy.suppressions.forbid,
};

function isRuleId(id: string): id is RuleId {
  return id in ENABLED;
}

export const checkHeuristics: Check = (changes, context) =>
  changes
    .flatMap((change) => {
      const language = languageOf(change.path);
      if (language === null || change.newContent === null) return [];
      const isTest = context.testFiles.matchAnywhere(change.path) !== undefined;
      return violationsIn(change, language, isTest);
    })
    .filter((violation) => isRuleId(violation.ruleId) && ENABLED[violation.ruleId](context));
