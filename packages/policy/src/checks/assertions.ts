// tests.forbidAssertionReduction (SPEC §8.5): per test file, assertions and test functions counted
// in code with comments and strings stripped, old against new. Any decrease is a violation, so an
// assertion commented out, turned into a string or deleted counts, and so do merged tests.
import type { Change } from "../diff";
import { languageOf, stripCode, type Language } from "../source";
import { scanExpects } from "./expects";
import type { Check, Violation } from "./types";

const ASSERTIONS: Record<Language, readonly RegExp[]> = {
  js: [
    // expect(...) with a matcher is counted by scanExpects (bracket-balanced subjects). Here:
    // assertType(...), assert(...), assert.equal(...); not text in JSX (after a `>`, not `=>`).
    /(?<![\w$.])(?<!(?<!=)>\s*)assertType\s*\(/g,
    /(?<![\w$.])(?<!(?<!=)>\s*)assert(\s*\.\s*[\w$]+)?\s*\(/g,
    /\.\s*should\b/g,
    // AVA and tap: t.is(...), t.deepEqual(...), t.throws(...); not t.pass().
    /\bt\s*\.\s*(is|not|deepEqual|notDeepEqual|like|true|false|truthy|falsy|regex|notRegex|throws|throwsAsync|notThrows|notThrowsAsync|snapshot|assert|equal|same|strictSame|match|ok|notOk|rejects|resolves|has)\s*\(/g,
  ],
  python: [
    /(?<![.\w])assert\b/g,
    /\bself\s*\.\s*(assert\w*|fail\w*)\s*\(/g,
    /\bassert_\w*\s*\(/g,
    // pytest.raises asserts only as a context manager, or with the callable to run.
    /\bwith\s+pytest\s*\.\s*(raises|warns|deprecated_call)\s*\(/g,
    /(?<!\bwith\s+)\bpytest\s*\.\s*(raises|warns)\s*\([^,()]+,\s*[\w.]+/g,
  ],
};

const TESTS: Record<Language, RegExp> = {
  // Skipped and focused tests (xit, fit) still count: tests.forbidSkips reports them.
  js: /\b[xf]?(it|test)\b\s*(\.\s*[\w$]+\s*)*\(/g,
  python: /^[ \t]*(async\s+)?def\s+test\w*\s*\(/gm,
};

function count(code: string, patterns: readonly RegExp[]): number {
  return patterns.reduce((sum, pattern) => sum + (code.match(pattern)?.length ?? 0), 0);
}

interface Counts {
  assertions: number;
  tests: number;
}

function countsOf(path: string, content: string | null): Counts | null {
  const language = languageOf(path);
  if (language === null || content === null) return null;
  const code = stripCode(content, language);
  const expects = language === "js" ? scanExpects(code).asserting : 0;
  return {
    assertions: count(code, ASSERTIONS[language]) + expects,
    tests: count(code, [TESTS[language]]),
  };
}

function violationsIn(change: Change): Violation[] {
  const before = countsOf(change.oldPath ?? change.path, change.oldContent);
  const after = countsOf(change.path, change.newContent);
  if (before === null || after === null) return [];
  const violations: Violation[] = [];
  if (after.assertions < before.assertions) {
    violations.push({
      ruleId: "tests.forbidAssertionReduction",
      path: change.path,
      message: `${change.path} has ${String(after.assertions)} assertions, down from ${String(before.assertions)}.`,
      hint: "Keep every assertion. Fix the code under test so they pass.",
    });
  }
  if (after.tests < before.tests) {
    violations.push({
      ruleId: "tests.forbidAssertionReduction",
      path: change.path,
      message: `${change.path} has ${String(after.tests)} tests, down from ${String(before.tests)}.`,
      hint: "Keep every test. Fix the code under test so they pass.",
    });
  }
  return violations;
}

/**
 * Test files that stay test files. A deleted test file, or one renamed away, is INV-TEST-DELETE's;
 * a new one can't lose anything.
 */
export const checkAssertions: Check = (changes, { policy, testFiles }) => {
  if (!policy.tests.forbidAssertionReduction) return [];
  const isTest = (path: string) => testFiles.matchAnywhere(path) !== undefined;
  return changes.flatMap((change) => {
    const stays = change.status !== "added" && change.status !== "deleted";
    return stays && isTest(change.oldPath ?? change.path) && isTest(change.path)
      ? violationsIn(change)
      : [];
  });
};
