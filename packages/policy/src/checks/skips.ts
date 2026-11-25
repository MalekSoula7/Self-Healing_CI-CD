// tests.forbidSkips (SPEC §8.5): skip markers and early exits on added lines of test files, read
// with comments and strings stripped (so `// never it.skip(` is fine). An early exit is a test
// that stops before its assertions: a `return` followed by more code in the same block, a `return;`
// then a statement on one line, or `if (false)` / `if False:`.
import type { Change } from "../diff";
import { addedLines, languageOf, stripCode, type Language } from "../source";
import type { Check, Violation } from "./types";

const SKIP_MARKERS: Record<Language, readonly RegExp[]> = {
  js: [
    // it.skip, describe.only, test.todo, test.fixme, it.skipIf(...), it.runIf(...), also as values.
    /\.\s*(skip|only|todo|fixme|skipIf|runIf)\b/,
    /\b(xit|xdescribe|xtest|xspec|fit|fdescribe)\s*\(/,
  ],
  python: [
    /\bpytest\s*\.\s*mark\s*\.\s*(skip|skipif|xfail)\b/,
    /\bpytest\s*\.\s*(skip|xfail|importorskip)\s*\(/,
    /\bunittest\s*\.\s*(skip|skipIf|skipUnless|expectedFailure)\b/,
    /^\s*@\s*(skip|skipIf|skipUnless|expectedFailure)\b/,
    /\.\s*skipTest\s*\(/,
  ],
};

const DEAD_CONDITION: Record<Language, RegExp> = {
  js: /\b(if|while)\s*\(\s*(false|0|null|undefined|void\s+0|!\s*(true|1)|""|''|``)\s*\)/,
  python: /^\s*(if|while|elif)\s+(False|0|None|not\s+True|""|'')\s*:/,
};

const RETURN_THEN_CODE = /\breturn\b[^;{}]*;\s*[^\s;}]/;
const BARE_RETURN = /^(\s*)return\b/;
// Lines that may follow a return in the same block: closers, other branches, continuations of
// the returned expression, and hoisted function declarations.
const AFTER_RETURN_OK =
  /^\s*([})\]>.?:+\-*/%&|^,]|case\b|default\b|else\b|elif\b|except\b|finally\b|catch\b|function\b)/;

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

function violationsIn(change: Change, language: Language): Violation[] {
  const stripped = stripCode(change.newContent ?? "", language).split("\n");
  const violations: Violation[] = [];
  for (const { line } of addedLines(change)) {
    const code = stripped[line - 1] ?? "";
    if (SKIP_MARKERS[language].some((marker) => marker.test(code))) {
      violations.push({
        ruleId: "tests.forbidSkips",
        path: change.path,
        line,
        message: `${change.path}:${String(line)} skips or focuses tests.`,
        hint: "Run every test as it was. Fix the code under test instead of skipping tests.",
      });
    } else if (
      DEAD_CONDITION[language].test(code) ||
      RETURN_THEN_CODE.test(code) ||
      unreachableAfter(stripped, line - 1)
    ) {
      violations.push({
        ruleId: "tests.forbidSkips",
        path: change.path,
        line,
        message: `${change.path}:${String(line)} stops a test before code that would run.`,
        hint: "Let every test run all of its assertions. Fix the code under test instead.",
      });
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
