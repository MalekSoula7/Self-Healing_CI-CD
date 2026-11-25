// tests.forbidSkips (SPEC §8.5): skip markers, process exits and early exits on added lines of
// test files.
// - Skip markers and exits are matched on the raw line, comments and strings included: the
//   stripper reads JSX, f-string fields and odd line endings differently from the real lexers
//   (P3.6 red team), and a marker mentioned in a comment is cheap to rephrase. Fail closed.
// - Early exits are read on stripped code: a `return` followed by more code in the same block,
//   `return; x()` on one line, a `return` under an `if` inside a test, and dead conditions.
// - A test file with line terminators other than `\n` and `\r\n` is refused outright: JavaScript
//   and Python end lines at a lone `\r` (and JavaScript at U+2028/U+2029), which hides code from
//   any line-based reading.
import type { Change } from "../diff";
import { addedLines, languageOf, stripCode, type Language } from "../source";
import type { Check, Violation } from "./types";

const SKIP_NAMES = "skip|only|todo|fixme|skipIf|runIf|fails|failing";

const SKIP_MARKERS: Record<Language, readonly RegExp[]> = {
  js: [
    // it.skip, describe.only, test.todo, test.fixme, it.fails, test.failing, also as values.
    new RegExp(`\\.\\s*(${SKIP_NAMES})\\b`),
    /\b(xit|xdescribe|xtest|xspec|fit|fdescribe)\s*\(/,
    // it["skip"], test[name]: computed access to the runner's functions.
    /\b(it|test|describe|suite|context|bench)\s*\[/,
    // const { skip: it } = test; ({ skip }) => skip(): the runner's skip, destructured.
    new RegExp(
      `\\{[^}]*\\b(${SKIP_NAMES})\\b[^}]*\\}\\s*(=\\s*(it|test|describe|suite)\\b|\\)\\s*=>)`,
    ),
    // it.each([]): a test that never runs.
    /\.\s*each\s*\(\s*\[\s*\]\s*\)/,
  ],
  python: [
    /\bmark\s*\.\s*(skip|skipif|xfail)\b/,
    /\bpytest\s*\.\s*(skip|xfail|importorskip)\b/,
    /\bunittest\s*\.\s*(skip|skipIf|skipUnless|expectedFailure)\b/,
    /^\s*@\s*(skip|skipIf|skipUnless|expectedFailure)\b/,
    /\bSkipTest\b|\bskipTest\s*\(|\bskip\s*\.\s*Exception\b/,
    /\bimport\b.*\b(skip|skipif|skipIf|skipUnless|xfail|SkipTest|expectedFailure|importorskip)\b/,
    /\bgetattr\s*\(\s*(pytest|unittest|mark)\b/,
    /\b(collect_ignore|collect_ignore_glob|pytest_collection_modifyitems|pytest_ignore_collect|pytest_deselected)\b/,
    /\bparametrize\s*\([^)]*,\s*(\[\s*\]|\(\s*\))\s*[,)]/,
  ],
};

const EXITS: Record<Language, RegExp> = {
  js: /\bprocess\s*\.\s*(exit|kill|abort|reallyExit)\b/,
  python:
    /\b(os\s*\.\s*(_exit|abort|kill)|sys\s*\.\s*exit|pytest\s*\.\s*exit)\b|\bSystemExit\b|^\s*(exit|quit)\s*\(/,
};

const DEAD_CONDITION: Record<Language, RegExp> = {
  js: /\b(if|while)\s*\(\s*(false|0|null|undefined|void\s+0|!\s*(true|1)|""|''|``)\s*\)/,
  python: /^\s*(if|while|elif)\s+(False|0|None|not\s+True|""|'')\s*:/,
};

const TEST_START: Record<Language, RegExp> = {
  js: /\b[xf]?(it|test)\b[\w$.\s]*\(/,
  python: /^\s*(async\s+)?def\s+test\w*\s*\(/,
};
const FUNCTION_START = /\bfunction\b|=>|^\s*(async\s+)?def\s/;
const CONDITIONAL = /^\s*(\}\s*)?(if|elif|else|switch|case)\b/;

const RETURN_THEN_CODE = /\breturn\b[^;{}]*;\s*[^\s;}]/;
const BARE_RETURN = /^(\s*)return\b/;
// Lines that may follow a return in the same block: closers, other branches, continuations of
// the returned expression, and hoisted function declarations.
const AFTER_RETURN_OK =
  /^\s*([})\]>.?:+\-*/%&|^,]|case\b|default\b|else\b|elif\b|except\b|finally\b|catch\b|function\b)/;
const ODD_LINE_ENDS = /\r(?!\n)|[\u2028\u2029]/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Code still runs after this `return`? Then the code after it in the same block never does. */
function unreachableAfter(lines: readonly string[], index: number): boolean {
  const match = BARE_RETURN.exec(lines[index] ?? "");
  if (match === null) return false;
  for (let next = index + 1; next < lines.length; next += 1) {
    const line = lines[next] ?? "";
    if (line.trim() === "") continue;
    return indentOf(line) === (match[1] ?? "").length && !AFTER_RETURN_OK.test(line);
  }
  return false;
}

/**
 * A `return` under a condition, directly in a test (not in a helper or callback inside it): the
 * enclosing lines, walked outwards by indentation, reach a conditional before the test's start.
 */
function guardedReturnInTest(lines: readonly string[], index: number, language: Language): boolean {
  const line = lines[index] ?? "";
  if (!/\breturn\b/.test(line)) return false;
  let guarded = /\bif\b.*\breturn\b/.test(line);
  let threshold = indentOf(line);
  for (let previous = index - 1; previous >= 0 && threshold > 0; previous -= 1) {
    const ancestor = lines[previous] ?? "";
    if (ancestor.trim() === "" || indentOf(ancestor) >= threshold) continue;
    threshold = indentOf(ancestor);
    if (TEST_START[language].test(ancestor)) return guarded;
    if (FUNCTION_START.test(ancestor)) return false;
    if (CONDITIONAL.test(ancestor)) guarded = true;
  }
  return false;
}

function violation(change: Change, line: number, message: string, hint: string): Violation {
  return {
    ruleId: "tests.forbidSkips",
    path: change.path,
    line,
    message: `${change.path}:${String(line)} ${message}`,
    hint,
  };
}

/** Names bound to a skip marker anywhere in the file (`const later = cond ? it : it.skip`). */
function skipAliases(code: string): RegExp | null {
  const names = [
    ...code.matchAll(
      new RegExp(`\\b(?:const|let|var)\\s+([\\w$]+)\\s*=[^;\\n]*\\.\\s*(?:${SKIP_NAMES})\\b`, "g"),
    ),
  ].map((match) => match[1] ?? "");
  return names.length === 0 ? null : new RegExp(`\\b(${names.join("|")})\\s*\\(`);
}

function violationsIn(change: Change, language: Language): Violation[] {
  const content = change.newContent ?? "";
  if (ODD_LINE_ENDS.test(content)) {
    return [
      violation(
        change,
        1,
        "has line breaks (a lone CR, U+2028 or U+2029) that test runners and line-based checks read differently.",
        "Use \\n or \\r\\n line endings only.",
      ),
    ];
  }
  const raw = content.split("\n");
  const stripped = stripCode(content, language).split("\n");
  const aliases = language === "js" ? skipAliases(stripCode(content, language)) : null;
  const violations: Violation[] = [];
  for (const { line } of addedLines(change)) {
    const text = raw[line - 1] ?? "";
    const code = stripped[line - 1] ?? "";
    if (
      SKIP_MARKERS[language].some((marker) => marker.test(text)) ||
      aliases?.test(code) === true
    ) {
      violations.push(
        violation(
          change,
          line,
          "skips, focuses or inverts tests (or names a way to, even in a comment).",
          "Run every test as it was. Fix the code under test instead of skipping tests; don't mention skip markers in comments.",
        ),
      );
    } else if (language === "js" && /\\\r?$/.test(text)) {
      // In JavaScript a backslash before a line break only continues a string: it lets code hide
      // from line-based reading, and a test never needs it.
      violations.push(
        violation(
          change,
          line,
          "continues a string onto the next line with a backslash.",
          "Write the string on one line, or use a template literal.",
        ),
      );
    } else if (EXITS[language].test(text)) {
      violations.push(
        violation(
          change,
          line,
          "ends the test process.",
          "Let the test runner finish and report every test.",
        ),
      );
    } else if (
      DEAD_CONDITION[language].test(code) ||
      RETURN_THEN_CODE.test(code) ||
      unreachableAfter(stripped, line - 1) ||
      guardedReturnInTest(stripped, line - 1, language)
    ) {
      violations.push(
        violation(
          change,
          line,
          "can stop a test before code that would run.",
          "Let every test run all of its assertions, with no early return. Fix the code under test instead.",
        ),
      );
    }
  }
  return violations;
}

export const checkSkips: Check = (changes, { policy, testFiles }) => {
  if (!policy.tests.forbidSkips) return [];
  return changes.flatMap((change) => {
    const language = languageOf(change.path);
    if (language === null || change.newContent === null) return [];
    if (testFiles.matchAnywhere(change.path) === undefined) return [];
    return violationsIn(change, language);
  });
};
