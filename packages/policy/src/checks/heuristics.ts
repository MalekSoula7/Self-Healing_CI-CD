// Rules added at CHECKPOINT 3 (Malek, from the P3.6 red team, SPEC §8.5): tricks that make a
// failing check pass without fixing anything, on added lines. Each is cheap and rare in real fixes.
// - Test files (tests.forbidAssertionReduction): tautological assertions, assertions swallowed by
//   an empty catch or `except AssertionError`, `expect(...).resolves/.rejects` neither awaited nor
//   returned. (tests.forbidSkips): retries.
// - Source files (tests.forbidSkips): code that detects the test runner, or patches the test
//   framework. (suppressions.forbid): an empty `catch {}` / `except ...: pass`, `as any` /
//   `as unknown as`, warning filters.
import type { Change } from "../diff";
import { addedLines, at, languageOf, stripCode, type Language } from "../source";
import type { Check, CheckContext, Violation } from "./types";

interface Rule {
  ruleId: "tests.forbidAssertionReduction" | "tests.forbidSkips" | "suppressions.forbid";
  /** Matched on the stripped line (code only) or the raw line (strings and comments included). */
  on: "code" | "raw";
  pattern: RegExp;
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

const TEST_RULES: Record<Language, readonly Rule[]> = {
  js: [
    {
      ...TAUTOLOGY,
      // expect(true), expect(1), expect(null), expect("")...: the subject is a literal.
      pattern: /\bexpect\s*\(\s*(true|false|null|undefined|-?\d+(\.\d+)?|"\s*"|'\s*'|`\s*`)\s*\)/,
    },
    { ...TAUTOLOGY, pattern: /\bassert(\s*\.\s*ok)?\s*\(\s*(true|1)\s*[,)]/ },
    {
      ruleId: "tests.forbidAssertionReduction",
      on: "code",
      pattern: /^\s*expect\b.*\.\s*(resolves|rejects)\b/,
      message: "leaves a .resolves/.rejects assertion floating: nothing waits for it.",
      hint: "await (or return) every expect(...).resolves / .rejects.",
    },
    {
      ...RETRY,
      pattern: /\b(jest|vi)\s*\.\s*retryTimes\s*\(|\bretry\s*:\s*\d|\bretries\s*[:(]\s*\d/,
    },
  ],
  python: [
    { ...TAUTOLOGY, pattern: /^\s*assert\s+(True|1|not\s+False|"\s*"|'\s*')\s*(,|$)/ },
    // assert (x, "msg"): a non-empty tuple is always true.
    { ...TAUTOLOGY, pattern: /^\s*assert\s*\(.*,.*\)\s*$/ },
    { ...TAUTOLOGY, pattern: /^\s*assert\b.*\bor\s+(True|1)\s*(,|$)/ },
    {
      ruleId: "tests.forbidAssertionReduction",
      on: "code",
      pattern: /^\s*except\s*\(?\s*AssertionError\b/,
      message: "catches failed assertions.",
      hint: "Let failed assertions fail the test.",
    },
    { ...RETRY, pattern: /@\s*(pytest\s*\.\s*mark\s*\.\s*)?(flaky|retry)\b|\breruns\s*=/ },
  ],
};

const TEST_DETECTION = {
  ruleId: "tests.forbidSkips",
  on: "raw",
  message: "detects the test runner, so the code behaves differently under test.",
  hint: "Fix the code for every caller, not only when tests run it.",
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
      pattern:
        /\b(VITEST|VITEST_WORKER_ID|JEST_WORKER_ID|JEST_WORKER)\b|import\.meta\.vitest\b|\bNODE_ENV\b.*["'`]test["'`]|typeof\s+(it|describe|jest|vi|expect)\s*!==?\s*["']undefined["']/,
    },
    {
      ...FRAMEWORK_PATCH,
      pattern: /\b(globalThis|global|window)\s*\.\s*(it|test|describe|expect|jest|vi)\s*=[^=]/,
    },
    {
      ruleId: "suppressions.forbid",
      on: "code",
      pattern: /\bas\s+any\b|\bas\s+unknown\s+as\b/,
      message: "escapes the type checker (as any / as unknown as).",
      hint: "Fix the types instead of casting them away.",
    },
    {
      ruleId: "suppressions.forbid",
      on: "raw",
      pattern: /\bprocess\s*\.\s*(noDeprecation|removeAllListeners\s*\(\s*["']warning)/,
      message: "silences runtime warnings.",
      hint: "Fix what the warning reports instead of silencing it.",
    },
  ],
  python: [
    {
      ...TEST_DETECTION,
      pattern:
        /\b(PYTEST_CURRENT_TEST|PYTEST_XDIST_WORKER|PYTEST_VERSION)\b|["']pytest["']\s+in\s+sys\s*\.\s*modules|sys\s*\.\s*modules\b.*["']pytest|\b_called_from_test\b/,
    },
    { ...FRAMEWORK_PATCH, pattern: /\bTestCase\s*\.\s*\w+\s*=[^=]|^\s*def\s+pytest_\w+\s*\(/ },
    {
      ruleId: "suppressions.forbid",
      on: "raw",
      pattern: /\bwarnings\s*\.\s*(filterwarnings|simplefilter)\s*\(\s*["']ignore/,
      message: "silences warnings.",
      hint: "Fix what the warning reports instead of silencing it.",
    },
  ],
};

/** An empty catch, or an except whose body is only `pass` / `...`, starting at `index`. */
function swallows(lines: readonly string[], index: number, language: Language): boolean {
  const line = at(lines, index);
  const nextCode = () => lines.slice(index + 1).find((next) => next.trim() !== "") ?? "";
  if (language === "js") {
    if (/\bcatch\s*(\([^)]*\))?\s*\{\s*\}/.test(line)) return true;
    return /\bcatch\s*(\([^)]*\))?\s*\{\s*$/.test(line) && /^\s*\}/.test(nextCode());
  }
  if (!/^\s*except\b[^:]*:/.test(line)) return false;
  if (/:\s*(pass|\.\.\.)\s*$/.test(line)) return true;
  return /^\s*except\b[^:]*:\s*$/.test(line) && /^\s*(pass|\.\.\.)\s*$/.test(nextCode());
}

function violationsIn(change: Change, language: Language, isTest: boolean): Violation[] {
  const content = change.newContent ?? "";
  const raw = content.split("\n");
  const code = stripCode(content, language).split("\n");
  const rules = (isTest ? TEST_RULES : SOURCE_RULES)[language];
  const violations: Violation[] = [];
  const report = (line: number, ruleId: Rule["ruleId"], message: string, hint: string) => {
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
    const rule = rules.find((candidate) => candidate.pattern.test(text[candidate.on]));
    if (rule !== undefined) {
      report(line, rule.ruleId, rule.message, rule.hint);
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

const ENABLED: Record<Rule["ruleId"], (context: CheckContext) => boolean> = {
  "tests.forbidAssertionReduction": ({ policy }) => policy.tests.forbidAssertionReduction,
  "tests.forbidSkips": ({ policy }) => policy.tests.forbidSkips,
  "suppressions.forbid": ({ policy }) => policy.suppressions.forbid,
};

export const checkHeuristics: Check = (changes, context) =>
  changes
    .flatMap((change) => {
      const language = languageOf(change.path);
      if (language === null || change.newContent === null) return [];
      const isTest = context.testFiles.matchAnywhere(change.path) !== undefined;
      return violationsIn(change, language, isTest);
    })
    .filter((violation) => ENABLED[violation.ruleId as Rule["ruleId"]](context));
