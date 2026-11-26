// `expect(...)` calls in JavaScript test code (comments and strings stripped), read with their
// subject bracket-balanced (P3.6 round 4): a subject may hold a block arrow with semicolons.
// - An expect asserts only with a matcher after it: Jest/Vitest `.toBe(`, chai `.to.equal(`,
//   `.should`, through `.not` / `.resolves` / `.rejects`. `expect(x);` alone asserts nothing.
// - An expect is inverted when its subject runs another assertion and it expects a throw:
//   `expect(() => { expect(x).toBe(1) }).toThrow()` turns the failing assertion into the pass.
import { at } from "../source";

const EXPECT = /(?<![\w$.])(?<!(?<!=)>\s*)(expect(\s*\.\s*(soft|poll))?|expectTypeOf)\s*\(/g;
const MATCHER =
  /^\s*(\.\s*(not|resolves|rejects)\s*)*\.\s*(to(?!String\b|JSON\b|LocaleString\b)[A-Z]\w*\s*\(|to\b|should\b|be\b|have\b)/;
const EXPECTS_THROW = /^\s*(\.\s*not\s*)?\.\s*(toThrow\w*\s*\(|rejects\b|to\s*\.\s*throw\b)/;
const ASSERTS = /(?<![\w$.])(expect\s*\(|assert\b)/;

/** Index of the bracket closing the one at `open`, or the end of the code. */
const MAX_SUBJECT_CHARS = 5_000;

function closing(code: string, open: number): number {
  let depth = 0;
  // Bounded: unbalanced brackets in a large file must not make every expect scan to its end.
  const end = Math.min(code.length, open + MAX_SUBJECT_CHARS);
  for (let index = open; index < end; index += 1) {
    const char = at(code, index);
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return end;
}

export interface Expects {
  /** expect(...) calls followed by a matcher. */
  asserting: number;
  /** expect(...) calls whose subject asserts, expecting a throw. */
  inverted: number;
}

/** The code of a local `const name = ...` or `function name(...) {...}`, or "". */
function definitionOf(code: string, name: string): string {
  const id = name.replace(/\$/g, "\\$");
  const start = new RegExp(`(?:const|let|var)\\s+${id}\\s*=|function\\s+${id}\\s*\\(`).exec(code);
  if (start === null) return "";
  let depth = 0;
  const limit = Math.min(code.length, start.index + MAX_SUBJECT_CHARS);
  for (let index = start.index + start[0].length; index < limit; index += 1) {
    const char = at(code, index);
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth < 0 || (depth === 0 && char === "}" && start[0].startsWith("function"))) {
        return code.slice(start.index, index + 1);
      }
    } else if (depth === 0 && (char === ";" || char === "\n")) {
      return code.slice(start.index, index);
    }
  }
  return code.slice(start.index, limit);
}

export function scanExpects(code: string): Expects {
  const definitions = new Map<string, string>();
  let asserting = 0;
  let inverted = 0;
  for (const match of code.matchAll(EXPECT)) {
    const open = match.index + match[0].length - 1;
    const close = closing(code, open);
    const subject = code.slice(open + 1, close);
    const rest = code.slice(close + 1, close + 200);
    if (MATCHER.test(rest)) asserting += 1;
    // The subject may be a local function holding the assertion: expect(run).toThrow().
    const named = /^\s*([\w$]+)\s*$/.exec(subject)?.[1];
    let body = subject;
    if (named !== undefined) {
      body = definitions.get(named) ?? definitionOf(code, named);
      definitions.set(named, body);
    }
    if (ASSERTS.test(body) && EXPECTS_THROW.test(rest)) inverted += 1;
  }
  return { asserting, inverted };
}
