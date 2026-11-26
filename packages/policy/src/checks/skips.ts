// tests.forbidSkips (SPEC §8.5): ways to skip, focus, invert or stop tests, in test files.
// - Markers (skips, focus, inverted outcomes, empty tables, process exits, Python collection
//   tricks) are counted over the whole file, old against new: more of them is a violation. Each
//   file is normalized first (`\u` escapes decoded, NFKC, JavaScript whitespace collapsed), so a
//   marker split across lines or spelled with escapes or fullwidth letters still counts, and a
//   marker the file already had doesn't block an unrelated fix. Patterns are anchored to the test
//   runner's own names, so `.todo-list` or `store.only` don't count (P3.6, rounds 1 and 2).
// - Early exits are read on the added lines: a `return`/`break`/`continue` with more code after
//   it in the same block, `return; x()` on one line, a `return` under a condition inside a test,
//   a labelled `break`, and dead conditions. Both the stripped and the raw line are read, since the
//   stripper can misread JSX and regular expressions.
// - An added line with a lone CR or U+2028/U+2029, or a JavaScript string continued with a
//   backslash, is refused: line-based reading can't follow them.
import type { Change } from "../diff";
import { addedLines, at, languageOf, stripCode, type Language } from "../source";
import type { Check, Violation } from "./types";

const SKIP_NAMES = "skip|only|todo|fixme|skipIf|runIf|fails|failing";
const RUNNER = "it|test|describe|suite|bench";
const NOT_AFTER = "(?<![\\w$.])";

/** Decoded, NFKC, whitespace removed except between two word characters. */
function normalizeJs(text: string): string {
  const decoded = text
    .replace(
      /\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})/g,
      (match, long?: string, short?: string) => {
        const code = Number.parseInt(long ?? short ?? "", 16);
        return code <= 0x10ffff ? String.fromCodePoint(code) : match;
      },
    )
    .normalize("NFKC");
  return decoded.replace(/\s+/g, (space: string, offset: number) =>
    /[\w$]/.test(at(decoded, offset - 1)) && /[\w$]/.test(at(decoded, offset + space.length))
      ? " "
      : "",
  );
}

const JS_MARKERS: readonly RegExp[] = [
  // it.skip, describe.only, test.concurrent.fails, (it).todo
  new RegExp(`${NOT_AFTER}\\(?(${RUNNER})\\)?(\\.[\\w$]+)*\\.(${SKIP_NAMES})(?![\\w$])`, "g"),
  // it["skip"], (test)[name], Reflect.get(it, ...)
  new RegExp(`${NOT_AFTER}\\(?(it|test|describe)\\)?\\[`, "g"),
  /Reflect\.get\((it|test|describe)(?![\w$])/g,
  new RegExp(`${NOT_AFTER}(xit|xdescribe|xtest|xspec|fit|fdescribe)\\(`, "g"),
  // it(name, { skip: true }, fn)
  /[{,](skip|only|todo|fails|failing):(true|!0)[,}]/g,
  // it("name", ({ skip }) => ...), test("name", async function ({ skip }) ...)
  new RegExp(
    `${NOT_AFTER}(${RUNNER})(\\.[\\w$]+)*\\((["'\`])[^"'\`]*\\3,(async)?(\\(\\{|function[\\w$ ]*\\(\\{)[^}]*(?<![\\w$])(${SKIP_NAMES})(?![\\w$])`,
    "g",
  ),
  // const { skip } = ctx
  new RegExp(
    `(const|let|var)\\{[^}]*(?<![\\w$])(${SKIP_NAMES})(?![\\w$])[^}]*\\}=(ctx|context|task|t|${RUNNER})(?![\\w$])`,
    "g",
  ),
  // it.each([]), test.for([] as number[])
  /\.(each|for)\(\[\](as [\w$<>[\]]+)?\)/g,
  // for (const x of []) { expect(...) }
  /for\((const|let|var) [\w$]+ of(\[\]|""|''|``)\)/g,
  /process\.(exit|abort|reallyExit)\(|process\.kill\(process\.pid/g,
];

function jsAliases(normalized: string): RegExp | null {
  const names = [
    ...normalized.matchAll(
      new RegExp(
        `(?:const|let|var) ([\\w$]+)=[^;]*?${NOT_AFTER}\\(?(?:${RUNNER})\\)?(?:\\.[\\w$]+)*\\.(?:${SKIP_NAMES})(?![\\w$])`,
        "g",
      ),
    ),
  ].map((match) => at(match, 1));
  return names.length === 0 ? null : new RegExp(`${NOT_AFTER}(${names.join("|")})\\(`, "g");
}

/** Names Python code can reach pytest/unittest by: the modules and their `as` aliases. */
function pythonModules(text: string): string {
  const aliases = [
    ...text.matchAll(/^\s*import\s+(?:pytest|unittest|_pytest[\w.]*)\s+as\s+(\w+)/gm),
    ...text.matchAll(
      /^\s*from\s+(?:_pytest[\w.]*|pytest)\s+import\s+(?:\w+\s+as\s+)?(outcomes)\b/gm,
    ),
  ].map((match) => at(match, 1));
  return ["pytest", "unittest", "outcomes", ...aliases].join("|");
}

const SKIP_IMPORTS =
  /^\s*from\s+(pytest|_pytest[\w.]*|unittest[\w.]*)\s+import\s+[^\n]*\b(skip|skipif|skipIf|skipUnless|xfail|SkipTest|expectedFailure|importorskip|exit|outcomes)\b/gm;

function pythonMarkers(modules: string): readonly RegExp[] {
  return [
    /\bmark\s*\.\s*(skip|skipif|xfail)\b/g,
    new RegExp(`\\b(${modules})\\s*\\.\\s*(skip|xfail|importorskip|exit)\\b`, "g"),
    /\bunittest\s*\.\s*(skip|skipIf|skipUnless|expectedFailure)\b/g,
    /^\s*@\s*(skip|skipIf|skipUnless|expectedFailure)\b/gm,
    /\bSkipTest\b|\.\s*skipTest\s*\(|\bskip\s*\.\s*Exception\b/g,
    SKIP_IMPORTS,
    /\b__import__\s*\(|\bimport_module\s*\(/g,
    new RegExp(`\\bgetattr\\s*\\(\\s*(${modules}|mark)\\b`, "g"),
    // Collection: ignore lists, hooks, __test__, del, a fixture decorator on a test.
    /\b(collect_ignore|collect_ignore_glob)\b|^\s*(async\s+)?def\s+pytest_\w+|\b__test__\s*=|^\s*del\s+test_/gm,
    /@\s*(pytest\s*\.\s*)?fixture\b[^\n]*\n\s*(async\s+)?def\s+test_/g,
    /\bparametrize\s*\(\s*(["'])[^"']*\1\s*,\s*(\[\s*\]|\(\s*\))\s*[,)]/g,
    /^\s*for\s+\w+\s+in\s+(\[\s*\]|\(\s*\)|""|''|range\(\s*0\s*\))\s*:/gm,
    /\b(os\s*\.\s*(_exit|abort)|sys\s*\.\s*exit)\s*\(|\braise\s+SystemExit\b|^\s*(exit|quit)\s*\(/gm,
  ];
}

function count(text: string, patterns: readonly (RegExp | null)[]): number {
  return patterns.reduce(
    (sum, pattern) => sum + (pattern === null ? 0 : (text.match(pattern)?.length ?? 0)),
    0,
  );
}

/** Test functions shadowed by a later one with the same name, and `__init__` on test classes. */
function pythonShadows(text: string): number {
  const seen = new Set<string>();
  let shadows = 0;
  const classes: { indent: number; name: string }[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    while ((classes.at(-1)?.indent ?? -1) >= indent) classes.pop();
    const klass = /^\s*class\s+(\w+)/.exec(line);
    if (klass !== null) {
      classes.push({ indent, name: at(klass, 1) });
      continue;
    }
    const scope = classes.map((each) => each.name).join(".");
    const test = /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/.exec(line);
    if (test !== null) {
      const key = `${scope}.${at(test, 1)}`;
      if (seen.has(key)) shadows += 1;
      seen.add(key);
    }
    if (/^\s*def\s+__init__\s*\(/.test(line) && /(^|\.)Test\w*$/.test(scope)) shadows += 1;
  }
  return shadows;
}

function markerCount(content: string, language: Language): number {
  if (language === "js") {
    const normalized = normalizeJs(content);
    return count(normalized, [...JS_MARKERS, jsAliases(normalized)]);
  }
  const text = content.normalize("NFKC");
  return count(text, pythonMarkers(pythonModules(text))) + pythonShadows(text);
}

// ------------------------------------------------------------------------------------- early exits

const DEAD_CONDITION: Record<Language, RegExp> = {
  js: /\b(if|while)\s*\(\s*(false|0|null|undefined|void\s+0|!\s*(true|1)|""|''|``)\s*\)/,
  python: /^\s*(if|while|elif)\s+(False|0|None|not\s+True|""|'')\s*:/,
};

const TEST_START: Record<Language, RegExp> = {
  js: /^\s*[xf]?(it|test)\b(\s*\.\s*[\w$]+)*\s*\(/,
  python: /^\s*(async\s+)?def\s+test\w*\s*\(/,
};
const CONTROL = /^\s*(\}\s*)?(if|for|while|switch|catch|with|else|do|try)\b/;
const FUNCTION_START =
  /\bfunction\b|=>|^\s*(async\s+)?def\s|^\s*(async\s+|static\s+|get\s+|set\s+)*[\w$]+\s*\([^)]*\)\s*(:[^{]*)?\{\s*$/;
/** An anonymous callback (a named `function helper()` is a helper, not the test's callback). */
const CALLBACK_START = /^\s*(async\s*)?(\([^)]*\)\s*=>|[\w$]+\s*=>|function\s*\*?\s*\()/;
const CONDITIONAL = /^\s*(\}\s*)?(if|elif|else|switch|case)\b/;
/** The closing line of a multi-line Python signature: `) -> None:` or `):`. */
const SIGNATURE_END = /^\s*\)\s*(->[^:]*)?:\s*$/;

const RETURN_THEN_CODE = /\breturn\b[^;{}]*;\s*[^\s;}]/;
const EXIT_STATEMENT = /(^|[;{}])\s*(return|break|continue)\b/;
/** `if True: break`, or a `break`/`continue` right under an always-true condition. */
const TRUE_CONDITION =
  /^\s*(\}\s*)?(if|elif|while)\s*\(?\s*(True|true|1|!0|!false|not\s+False)\s*\)?\s*(:|\{)?/;
const LOOP_EXIT = /\b(break|continue)\b/;

function forcedLoopExit(lines: readonly string[], index: number): boolean {
  const line = at(lines, index);
  if (!LOOP_EXIT.test(line)) return false;
  if (TRUE_CONDITION.test(line)) return true;
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    const above = at(lines, previous);
    if (above.trim() !== "") return indentOf(above) < indentOf(line) && TRUE_CONDITION.test(above);
  }
  return false;
}

const LABELLED_BREAK = /\b(break|continue)\s+[\w$]+\s*;?\s*$/;
// Lines that may follow an exit in the same block: closers, other branches, continuations of
// the returned expression, and hoisted function declarations.
const AFTER_EXIT_OK =
  /^\s*([})\]>.?:+\-*/%&|^,]|case\b|default\b|else\b|elif\b|except\b|finally\b|catch\b|function\b)/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** An exit statement with more code after it, at the same indentation: code that never runs. */
function unreachableAfter(lines: readonly string[], index: number): boolean {
  const line = at(lines, index);
  if (!EXIT_STATEMENT.test(line)) return false;
  for (let next = index + 1; next < lines.length; next += 1) {
    const following = at(lines, next);
    if (following.trim() === "") continue;
    return indentOf(following) === indentOf(line) && !AFTER_EXIT_OK.test(following);
  }
  return false;
}

/** The line where a multi-line Python signature ending at `end` starts (`def ...(`). */
function signatureStart(lines: readonly string[], end: number): string {
  for (let index = end - 1; index >= 0; index -= 1) {
    const line = at(lines, index);
    if (/^\s*(async\s+)?def\s/.test(line)) return line;
  }
  return "";
}

/**
 * A `return` under a condition, directly in a test (not in a helper or callback inside it): the
 * enclosing lines, walked outwards by indentation, reach a conditional before the test's start.
 * A callback that is the test call's own argument (Prettier puts it on its own line for long
 * names) and the closing line of a multi-line Python signature lead on to the test's start.
 */
function guardedReturnInTest(lines: readonly string[], index: number, language: Language): boolean {
  const line = at(lines, index);
  if (!/\breturn\b/.test(line)) return false;
  let guarded = /\bif\b.*\breturn\b/.test(line);
  let threshold = indentOf(line);
  let callback = false;
  for (let previous = index - 1; previous >= 0 && threshold > 0; previous -= 1) {
    const ancestor = at(lines, previous);
    if (ancestor.trim() === "" || indentOf(ancestor) >= threshold) continue;
    threshold = indentOf(ancestor);
    const opener =
      language === "python" && SIGNATURE_END.test(ancestor)
        ? signatureStart(lines, previous)
        : ancestor;
    if (TEST_START[language].test(opener)) return guarded;
    if (callback) return false;
    if (FUNCTION_START.test(opener) && !CONTROL.test(opener)) {
      // The test's own callback, on a line of its own: the test call must be the next ancestor.
      if (language === "js" && CALLBACK_START.test(opener)) callback = true;
      else return false;
    } else if (CONDITIONAL.test(ancestor)) {
      guarded = true;
    }
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

const ODD_LINE_BREAK = new RegExp(`\\r(?!$)|[${String.fromCharCode(0x2028, 0x2029)}]`);
// An odd number of backslashes at the end: the last one escapes the line break.
const TRAILING_BACKSLASH = /(?<!\\)(\\\\)*\\\r?$/;

function lineViolations(change: Change, language: Language): Violation[] {
  const content = change.newContent ?? "";
  const raw = content.split("\n");
  const stripped = stripCode(content, language).split("\n");
  const violations: Violation[] = [];
  for (const { line, text } of addedLines(change)) {
    if (ODD_LINE_BREAK.test(text)) {
      violations.push(
        violation(
          change,
          line,
          "has a line break (a lone CR, U+2028 or U+2029) that runners and line-based checks read differently.",
          "Use \\n or \\r\\n line endings only.",
        ),
      );
      continue;
    }
    if (
      language === "js" &&
      TRAILING_BACKSLASH.test(text) &&
      /["']/.test(text) &&
      !text.includes("`")
    ) {
      violations.push(
        violation(
          change,
          line,
          "continues a string onto the next line with a backslash.",
          "Write the string on one line, or use a template literal.",
        ),
      );
      continue;
    }
    const exits = [stripped, raw].some(
      (lines) =>
        DEAD_CONDITION[language].test(at(lines, line - 1)) ||
        RETURN_THEN_CODE.test(at(lines, line - 1)) ||
        (language === "js" && LABELLED_BREAK.test(at(lines, line - 1))) ||
        unreachableAfter(lines, line - 1) ||
        forcedLoopExit(lines, line - 1) ||
        guardedReturnInTest(lines, line - 1, language),
    );
    if (exits) {
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

function violationsIn(change: Change, language: Language): Violation[] {
  const violations = lineViolations(change, language);
  const added =
    markerCount(change.newContent ?? "", language) - markerCount(change.oldContent ?? "", language);
  if (added > 0) {
    const [first] = addedLines(change);
    violations.push(
      violation(
        change,
        first?.line ?? 1,
        `adds ${added === 1 ? "a way" : `${String(added)} ways`} to skip, focus, invert or stop tests.`,
        "Run every test as it was. Fix the code under test instead of skipping, retrying or stopping tests.",
      ),
    );
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
