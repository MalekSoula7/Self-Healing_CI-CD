// `expect(...)` calls in JavaScript test code (comments and strings stripped), read with their
// subject bracket-balanced (P3.6 round 4): a subject may hold a block arrow with semicolons.
// - An expect asserts only with a matcher after it: Jest/Vitest `.toBe(`, chai `.to.equal(`,
//   `.should`, through `.not` / `.resolves` / `.rejects`. `expect(x);` alone asserts nothing.
// - An expect is inverted when its subject runs another assertion and it expects a throw:
//   `expect(() => { expect(x).toBe(1) }).toThrow()` turns the failing assertion into the pass.
import { at } from "../source";

const EXPECT = /(?<![\w$.])(?<!(?<!=)>\s*)(expect(\s*\.\s*(soft|poll))?|expectTypeOf)\s*\(/g;
const MATCHER =
  /^\s*(\.\s*(not|resolves|rejects)\s*)*\.\s*(to[A-Z]\w*\s*\(|to\b|should\b|be\b|have\b)/;
const EXPECTS_THROW = /^\s*(\.\s*not\s*)?\.\s*(toThrow\w*\s*\(|rejects\b|to\s*\.\s*throw\b)/;
const ASSERTS = /(?<![\w$.])(expect\s*\(|assert\b)/;

/** Index of the bracket closing the one at `open`, or the end of the code. */
function closing(code: string, open: number): number {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    const char = at(code, index);
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return code.length;
}

export interface Expects {
  /** expect(...) calls followed by a matcher. */
  asserting: number;
  /** expect(...) calls whose subject asserts, expecting a throw. */
  inverted: number;
}

export function scanExpects(code: string): Expects {
  let asserting = 0;
  let inverted = 0;
  for (const match of code.matchAll(EXPECT)) {
    const open = match.index + match[0].length - 1;
    const close = closing(code, open);
    const subject = code.slice(open + 1, close);
    const rest = code.slice(close + 1, close + 200);
    if (MATCHER.test(rest)) asserting += 1;
    if (ASSERTS.test(subject) && EXPECTS_THROW.test(rest)) inverted += 1;
  }
  return { asserting, inverted };
}
