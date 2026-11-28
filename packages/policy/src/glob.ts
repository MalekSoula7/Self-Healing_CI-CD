// Glob matching for policy paths (SPEC §8.5). Globs come from `.pipeheal.yml`, which anyone who
// can push may edit, so matching never builds a regular expression from them (no catastrophic
// backtracking) and brace expansion is bounded.
//
// Semantics (repo-relative POSIX paths):
// - `**` as a whole segment matches zero or more segments; anywhere else it is `*`;
// - `*` matches any characters except `/`, `?` exactly one; both match dotfiles, so `infra/**`
//   covers `infra/.secret` too;
// - `[abc]`, `[a-z]`, `[!abc]` / `[^abc]` match one character; an unclosed `[` is literal;
// - `{a,b}` alternatives, nested allowed; a brace without a comma or closing brace is literal.
// Characters are Unicode code points.
import { canonicalPath } from "@pipeheal/shared/repo-path";

export const MAX_GLOB_ALTERNATIVES = 64;

type Token =
  | { kind: "char"; value: string }
  | { kind: "any" }
  | { kind: "star" }
  | { kind: "class"; negated: boolean; ranges: [string, string][] };

type Segment = { kind: "globstar" } | { kind: "tokens"; tokens: Token[] };

export interface CompiledGlob {
  alternatives: Segment[][];
}

/** Expands `{a,b}` groups; null when that gives more than `limit` patterns. */
function expandBraces(glob: string, limit: number): string[] | null {
  if (limit < 1) return null;
  for (let open = 0; open < glob.length; open += 1) {
    if (glob[open] !== "{") continue;
    // The group's alternatives, split on its own commas (not a nested group's).
    const alternatives: string[] = [];
    let depth = 0;
    let start = open + 1;
    let close = -1;
    for (let index = open; index < glob.length && close === -1; index += 1) {
      const char = glob[index];
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      if ((char === "," && depth === 1) || (char === "}" && depth === 0)) {
        alternatives.push(glob.slice(start, index));
        start = index + 1;
        if (char === "}") close = index;
      }
    }
    if (close === -1 || alternatives.length < 2) continue;

    const prefix = glob.slice(0, open);
    const suffix = glob.slice(close + 1);
    const results: string[] = [];
    for (const alternative of alternatives) {
      const expanded = expandBraces(prefix + alternative + suffix, limit - results.length);
      if (expanded === null) return null;
      results.push(...expanded);
    }
    return results;
  }
  return [glob];
}

function parseClass(chars: readonly string[], start: number): { token: Token; end: number } | null {
  let index = start + 1;
  const negated = chars[index] === "!" || chars[index] === "^";
  if (negated) index += 1;
  const ranges: [string, string][] = [];
  // A `]` right after the opening (and negation) is a member, as in shells.
  let first = true;
  while (index < chars.length) {
    const char = chars[index] ?? "";
    if (char === "]" && !first) return { token: { kind: "class", negated, ranges }, end: index };
    first = false;
    const to = chars[index + 2];
    if (chars[index + 1] === "-" && to !== undefined && to !== "]") {
      ranges.push([char, to]);
      index += 3;
    } else {
      ranges.push([char, char]);
      index += 1;
    }
  }
  return null;
}

function parseSegment(segment: string): Segment {
  if (segment === "**") return { kind: "globstar" };
  const chars = Array.from(segment);
  const tokens: Token[] = [];
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index] ?? "";
    if (char === "*") {
      if (tokens.at(-1)?.kind !== "star") tokens.push({ kind: "star" });
    } else if (char === "?") {
      tokens.push({ kind: "any" });
    } else if (char === "[") {
      const parsed = parseClass(chars, index);
      if (parsed === null) tokens.push({ kind: "char", value: char });
      else {
        tokens.push(parsed.token);
        index = parsed.end;
      }
    } else {
      tokens.push({ kind: "char", value: char });
    }
  }
  return { kind: "tokens", tokens };
}

/** The compiled glob, or null when it expands to more than MAX_GLOB_ALTERNATIVES patterns. */
export function compileGlob(glob: string): CompiledGlob | null {
  const expanded = expandBraces(glob, MAX_GLOB_ALTERNATIVES);
  if (expanded === null) return null;
  return { alternatives: expanded.map((pattern) => pattern.split("/").map(parseSegment)) };
}

function matchesChar(token: Exclude<Token, { kind: "star" }>, char: string): boolean {
  switch (token.kind) {
    case "char":
      return token.value === char;
    case "any":
      return true;
    case "class": {
      const inside = token.ranges.some(([from, to]) => char >= from && char <= to);
      return inside !== token.negated;
    }
  }
}

/** One segment: the classic wildcard walk, backtracking only to the last star (O(n * m)). */
function matchesSegment(tokens: readonly Token[], chars: readonly string[]): boolean {
  let token = 0;
  let char = 0;
  let starToken = -1;
  let starChar = 0;
  while (char < chars.length) {
    const current = tokens[token];
    if (current?.kind === "star") {
      starToken = token;
      starChar = char;
      token += 1;
    } else if (current !== undefined && matchesChar(current, chars[char] ?? "")) {
      token += 1;
      char += 1;
    } else if (starToken !== -1) {
      token = starToken + 1;
      starChar += 1;
      char = starChar;
    } else {
      return false;
    }
  }
  while (tokens[token]?.kind === "star") token += 1;
  return token === tokens.length;
}

/** Segments: the set of reachable positions, segment by segment (O(pattern · path)). */
function matchesPattern(pattern: readonly Segment[], segments: readonly string[][]): boolean {
  let reachable = new Array<boolean>(segments.length + 1).fill(false);
  reachable[0] = true;
  for (const part of pattern) {
    const next = new Array<boolean>(segments.length + 1).fill(false);
    if (part.kind === "globstar") {
      let seen = false;
      for (let index = 0; index <= segments.length; index += 1) {
        seen ||= reachable[index] === true;
        next[index] = seen;
      }
    } else {
      for (let index = 0; index < segments.length; index += 1) {
        if (reachable[index] === true && matchesSegment(part.tokens, segments[index] ?? [])) {
          next[index + 1] = true;
        }
      }
    }
    reachable = next;
  }
  return reachable[segments.length] === true;
}

export function globMatches(glob: CompiledGlob, path: string): boolean {
  const segments = path.split("/").map((segment) => Array.from(segment));
  return glob.alternatives.some((pattern) => matchesPattern(pattern, segments));
}

export interface GlobList {
  /** The first glob matching the path exactly as written (allow lists: never widen them). */
  matchExact(path: string): string | undefined;
  /**
   * The first glob matching the path as written, or the file it is on a case-insensitive Windows
   * or macOS checkout (`canonicalPath`): deny lists and invariants, which must not be dodged by
   * `.GitHub/` or `GITHUB~1/`.
   */
  matchAnywhere(path: string): string | undefined;
}

function compileOrThrow(glob: string): CompiledGlob {
  const compiled = compileGlob(glob);
  if (compiled === null) {
    throw new Error(
      `glob expands to too many alternatives (over ${String(MAX_GLOB_ALTERNATIVES)})`,
    );
  }
  return compiled;
}

/** Compiles a list once. Throws on a glob the schema would refuse, so callers fail closed. */
export function globList(globs: readonly string[]): GlobList {
  const exact = globs.map((glob) => ({ glob, compiled: compileOrThrow(glob) }));
  const canonical = globs.map((glob) => ({ glob, compiled: compileOrThrow(canonicalPath(glob)) }));
  return {
    matchExact: (path) => exact.find(({ compiled }) => globMatches(compiled, path))?.glob,
    matchAnywhere(path) {
      const asWritten = exact.find(({ compiled }) => globMatches(compiled, path));
      if (asWritten !== undefined) return asWritten.glob;
      const target = canonicalPath(path);
      return canonical.find(({ compiled }) => globMatches(compiled, target))?.glob;
    },
  };
}
