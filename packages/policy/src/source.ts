// Source code as the test-integrity checks read it (SPEC §8.5): comments and string contents
// blanked, so `"expect(1)"` or `# assert x` never count as code. Offsets and line breaks are kept,
// so a line number in the stripped text is the line number in the file. A lexer, not a parser:
// good enough to tell code from comments and strings in files that also have to pass CI.
import type { Change } from "./diff";

export type Language = "js" | "python";

/** `list[index]`, or "" past either end: lines, characters, regular-expression groups. */
export function at(list: ArrayLike<string | undefined>, index: number): string {
  return list[index] ?? "";
}

const JS_EXTENSIONS = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/;
const PYTHON_EXTENSIONS = /\.(py|pyi)$/;

export function languageOf(path: string): Language | null {
  const lower = path.toLowerCase();
  if (JS_EXTENSIONS.test(lower)) return "js";
  if (PYTHON_EXTENSIONS.test(lower)) return "python";
  return null;
}

class Blanker {
  /** UTF-16 units, like the offsets everywhere else. */
  readonly out: string[];
  /** Keep string contents (and regular expressions): blank comments only. */
  constructor(
    source: string,
    private readonly keepStrings = false,
  ) {
    this.out = source.split("");
  }
  blankString(from: number, to: number): void {
    if (!this.keepStrings) this.blank(from, to);
  }
  /** Blanks [from, to), keeping line breaks. */
  blank(from: number, to: number): void {
    for (let index = from; index < to && index < this.out.length; index += 1) {
      const char = this.out[index];
      if (char !== "\n" && char !== "\r") this.out[index] = " ";
    }
  }
  toString(): string {
    return this.out.join("");
  }
}

// After these, a `/` starts a regular expression rather than dividing.
const REGEX_AFTER_CHAR = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
  "instanceof",
]);

function startsRegex(out: readonly string[], slash: number): boolean {
  let index = slash - 1;
  while (index >= 0 && /\s/.test(out[index] ?? "")) index -= 1;
  if (index < 0) return true;
  const previous = out[index] ?? "";
  // `x++ / 2` and `x-- / 2` divide: a postfix operator ends an operand.
  if ((previous === "+" || previous === "-") && out[index - 1] === previous) return false;
  if (REGEX_AFTER_CHAR.has(previous)) return true;
  if (!/[\w$]/.test(previous)) return false;
  let start = index;
  while (start > 0 && /[\w$]/.test(out[start - 1] ?? "")) start -= 1;
  return REGEX_AFTER_WORD.has(out.slice(start, index + 1).join(""));
}

/** End of a regular expression literal starting at `slash` (the closing slash), or -1. */
function regexEnd(source: string, slash: number): number {
  let inClass = false;
  for (let index = slash + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\n") return -1;
    if (char === "\\") index += 1;
    else if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) return index;
  }
  return -1;
}

/**
 * A quoted string opening at `open`: where its contents end (exclusive) and where code resumes.
 * Unterminated, it stops at the line break (single-line quotes) or the end of the file.
 */
function quoted(
  source: string,
  open: number,
  quote: string,
  multiline: boolean,
): { contentEnd: number; next: number } {
  for (let index = open + quote.length; index < source.length; index += 1) {
    const char = source[index];
    // A backslash escapes one character, or a CRLF line break as a whole (a continuation).
    if (char === "\\") index += source.startsWith("\r\n", index + 1) ? 2 : 1;
    else if (source.startsWith(quote, index)) {
      return { contentEnd: index, next: index + quote.length };
    } else if (char === "\n" && !multiline) return { contentEnd: index, next: index };
  }
  return { contentEnd: source.length, next: source.length };
}

function lineEnd(source: string, from: number): number {
  const end = source.indexOf("\n", from);
  return end === -1 ? source.length : end;
}

function stripJs(source: string, keepStrings = false): string {
  const text = new Blanker(source, keepStrings);
  // Open `${` expressions and `{` blocks, so a `}` knows whether it resumes a template.
  const stack: ("brace" | "template")[] = [];
  let inTemplate = false;
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (inTemplate) {
      if (char === "\\") {
        text.blankString(index, index + 2);
        index += 2;
      } else if (char === "`") {
        inTemplate = false;
        index += 1;
      } else if (char === "$" && next === "{") {
        stack.push("template");
        inTemplate = false;
        index += 2;
      } else {
        text.blankString(index, index + 1);
        index += 1;
      }
      continue;
    }
    // `<!--` (anywhere) and `-->` (at a line's start) are line comments in scripts (Annex B).
    const htmlComment =
      source.startsWith("<!--", index) ||
      (source.startsWith("-->", index) &&
        /(^|\n)[ \t]*$/.test(source.slice(Math.max(0, index - 200), index)));
    if ((char === "/" && next === "/") || htmlComment) {
      const end = lineEnd(source, index);
      text.blank(index, end);
      index = end;
    } else if (char === "/" && next === "*") {
      const close = source.indexOf("*/", index + 2);
      const end = close === -1 ? source.length : close + 2;
      text.blank(index, end);
      index = end;
    } else if (char === "'" || char === '"') {
      const { contentEnd, next: after } = quoted(source, index, char, false);
      text.blankString(index + 1, contentEnd);
      index = after;
    } else if (char === "`") {
      inTemplate = true;
      index += 1;
    } else if (char === "/" && startsRegex(text.out, index)) {
      const end = regexEnd(source, index);
      if (end !== -1) text.blankString(index + 1, end);
      index = end === -1 ? index + 1 : end + 1;
    } else {
      if (char === "{") stack.push("brace");
      else if (char === "}" && stack.pop() === "template") inTemplate = true;
      index += 1;
    }
  }
  return text.toString();
}

const MAX_FSTRING_DEPTH = 16;

/**
 * Python code from `start`: comments and strings blanked, f-string replacement fields read as
 * code (PEP 701 lets them hold any expression, strings with the same quotes included). Inside a
 * field (`depth` > 0) it stops at the field's closing `}` and returns the index after it.
 */
function pythonCode(source: string, text: Blanker, start: number, depth: number): number {
  let index = start;
  let braces = 0;
  while (index < source.length) {
    const char = source[index] ?? "";
    if (char === "#") {
      const end = lineEnd(source, index);
      text.blank(index, end);
      index = end;
    } else if (char === "'" || char === '"') {
      index = pythonString(source, text, index, depth);
    } else if (depth > 0 && char === "{") {
      braces += 1;
      index += 1;
    } else if (depth > 0 && char === "}") {
      if (braces === 0) return index + 1;
      braces -= 1;
      index += 1;
    } else {
      index += 1;
    }
  }
  return index;
}

/** A string literal opening at `open`; f-string fields stay code. Returns where code resumes. */
function pythonString(source: string, text: Blanker, open: number, depth: number): number {
  const char = source[open] ?? "";
  const triple = source.startsWith(char.repeat(3), open);
  const quote = triple ? char.repeat(3) : char;
  // A prefix is a whole token: the `f` ending `if"..."` is not one.
  const prefix =
    /(?<![\w])[rRbBuUfF]{1,2}$/.exec(source.slice(Math.max(0, open - 3), open))?.[0] ?? "";
  const { contentEnd, next } = quoted(source, open, quote, triple);
  if (!/f/i.test(prefix) || depth >= MAX_FSTRING_DEPTH) {
    text.blankString(open + quote.length, contentEnd);
    return next;
  }
  // An f-string: blank its literal parts, read `{...}` fields as code (`{{` is a literal brace).
  let index = open + quote.length;
  while (index < source.length) {
    if (source.startsWith(quote, index)) return index + quote.length;
    const current = source[index];
    if (current === "\\") {
      text.blankString(index, index + 2);
      index += 2;
    } else if (current === "{" && source[index + 1] === "{") {
      text.blankString(index, index + 2);
      index += 2;
    } else if (current === "{") {
      index = pythonCode(source, text, index + 1, depth + 1);
    } else if (current === "\n" && !triple) {
      return index;
    } else {
      text.blankString(index, index + 1);
      index += 1;
    }
  }
  return index;
}

function stripPython(source: string, keepStrings = false): string {
  const text = new Blanker(source, keepStrings);
  pythonCode(source, text, 0, 0);
  return text.toString();
}

/** `source` with comments and string contents blanked; same length, same line breaks. */
export function stripCode(source: string, language: Language): string {
  return language === "js" ? stripJs(source) : stripPython(source);
}

/** `source` with comments blanked, strings kept; same length, same line breaks. */
export function stripComments(source: string, language: Language): string {
  return language === "js" ? stripJs(source, true) : stripPython(source, true);
}

export interface AddedLine {
  /** 1-based, in the new content. */
  line: number;
  text: string;
}

/** The lines a change adds, with their numbers in the new content. */
export function addedLines(change: Change): AddedLine[] {
  const added: AddedLine[] = [];
  for (const hunk of change.hunks) {
    let line = hunk.newStart;
    for (const hunkLine of hunk.lines) {
      if (hunkLine.type === "del") continue;
      if (hunkLine.type === "add") added.push({ line, text: hunkLine.text });
      line += 1;
    }
  }
  return added;
}
