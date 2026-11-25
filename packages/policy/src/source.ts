// Source code as the test-integrity checks read it (SPEC §8.5): comments and string contents
// blanked, so `"expect(1)"` or `# assert x` never count as code. Offsets and line breaks are kept,
// so a line number in the stripped text is the line number in the file. A lexer, not a parser:
// good enough to tell code from comments and strings in files that also have to pass CI.
import type { Change } from "./diff";

export type Language = "js" | "python";

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
  constructor(source: string) {
    this.out = source.split("");
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
    if (char === "\\") index += 1;
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

function stripJs(source: string): string {
  const text = new Blanker(source);
  // Open `${` expressions and `{` blocks, so a `}` knows whether it resumes a template.
  const stack: ("brace" | "template")[] = [];
  let inTemplate = false;
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (inTemplate) {
      if (char === "\\") {
        text.blank(index, index + 2);
        index += 2;
      } else if (char === "`") {
        inTemplate = false;
        index += 1;
      } else if (char === "$" && next === "{") {
        stack.push("template");
        inTemplate = false;
        index += 2;
      } else {
        text.blank(index, index + 1);
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "/") {
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
      text.blank(index + 1, contentEnd);
      index = after;
    } else if (char === "`") {
      inTemplate = true;
      index += 1;
    } else if (char === "/" && startsRegex(text.out, index)) {
      const end = regexEnd(source, index);
      if (end !== -1) text.blank(index + 1, end);
      index = end === -1 ? index + 1 : end + 1;
    } else {
      if (char === "{") stack.push("brace");
      else if (char === "}" && stack.pop() === "template") inTemplate = true;
      index += 1;
    }
  }
  return text.toString();
}

function stripPython(source: string): string {
  const text = new Blanker(source);
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "#") {
      const end = lineEnd(source, index);
      text.blank(index, end);
      index = end;
    } else if (char === "'" || char === '"') {
      const triple = source.startsWith(char.repeat(3), index);
      const quote = triple ? char.repeat(3) : char;
      const { contentEnd, next } = quoted(source, index, quote, triple);
      text.blank(index + quote.length, contentEnd);
      index = next;
    } else {
      index += 1;
    }
  }
  return text.toString();
}

/** `source` with comments and string contents blanked; same length, same line breaks. */
export function stripCode(source: string, language: Language): string {
  return language === "js" ? stripJs(source) : stripPython(source);
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
