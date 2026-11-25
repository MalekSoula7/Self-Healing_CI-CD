// How big a dependency spec change is (SPEC §8.5): `none`, `patch`, `minor`, or `any` (a major
// bump, a downgrade, a wider range than the mode allows, or a spec we can't read). Pure; no
// registry lookups. A spec is read as its lowest version and its width (how far it lets the
// installed version move): `1.2.3` pins, `~1.2.3` allows patches, `^1.2.3` minors, `*` anything.
// Changes are conservative: what we can't classify needs `any`.

export type ChangeLevel = "none" | "patch" | "minor" | "any";
export type DependencyMode = "frozen" | "patch" | "minor" | "any";

/** `npm`: npm/yarn/pnpm and Poetry ranges. `pep440`: Python specifiers. `opaque`: compared as text. */
export type SpecSyntax = "npm" | "pep440" | "opaque";

export interface DependencySpec {
  syntax: SpecSyntax;
  spec: string;
}

const RANK: Record<ChangeLevel, number> = { none: 0, patch: 1, minor: 2, any: 3 };
const LEVELS: readonly ChangeLevel[] = ["none", "patch", "minor", "any"];
const MODE_ALLOWS: Record<DependencyMode, ChangeLevel> = {
  frozen: "none",
  patch: "patch",
  minor: "minor",
  any: "any",
};

export function levelAllowed(mode: DependencyMode, level: ChangeLevel): boolean {
  return RANK[level] <= RANK[MODE_ALLOWS[mode]];
}

interface Range {
  /** The lowest version the spec accepts, as release numbers. */
  min: number[];
  /** 0: exact, 1: patches, 2: minors, 3: anything. */
  width: number;
}

const VERSION = /^v?(\d+)(?:\.(\d+|[x*]))?(?:\.(\d+|[x*]))?(?:[-+][0-9A-Za-z.-]+)?$/i;

/** npm and Poetry: exact, `=`, `^`, `~`, x-ranges, `*`; anything else is unreadable (null). */
function npmRange(spec: string): Range | null {
  const trimmed = spec.trim();
  if (trimmed === "" || trimmed === "*" || /^(x|latest)$/i.test(trimmed)) {
    return { min: [0], width: 3 };
  }
  const operator = /^(\^|~|=)?\s*/.exec(trimmed)?.[1] ?? "";
  const match = VERSION.exec(trimmed.slice(operator.length).trim());
  if (match === null) return null;
  const parts = [match[1], match[2], match[3]];
  // Components given as numbers; an x, * or missing one leaves that position free.
  const given = parts.findIndex((part) => part === undefined || !/^\d+$/.test(part));
  const known = given === -1 ? 3 : given;
  const min = parts.slice(0, known).map(Number);
  const freeWidth = 3 - known;
  if (operator === "^") {
    // ^ allows changes after the first non-zero component (^1.2.3: minors; ^0.2.3: patches).
    const firstNonZero = min.findIndex((part) => part !== 0);
    const fixed = firstNonZero === -1 ? known : firstNonZero + 1;
    return { min, width: Math.max(freeWidth, 3 - fixed) };
  }
  if (operator === "~") return { min, width: Math.max(freeWidth, known >= 2 ? 1 : 2) };
  return { min, width: freeWidth };
}

const PEP440_VERSION =
  /^(\d+(?:\.\d+)*)(\.\*)?([._-]?(a|b|rc|alpha|beta|c|pre|preview|post|dev)\d*)*$/i;

/** One clause (`==`, `===`, `~=`, `>=`) or none; anything else is unreadable (null). */
function pep440Range(specifier: string): Range | null {
  const trimmed = specifier.trim();
  if (trimmed === "") return { min: [0], width: 3 };
  const match = /^(===|==|~=|>=)\s*(\S+)$/.exec(trimmed);
  const version = match === null ? null : PEP440_VERSION.exec(match[2] ?? "");
  if (match === null || version === null) return null;
  const min = (version[1] ?? "").split(".").map(Number);
  if (match[1] === ">=") return { min, width: 3 };
  if (match[1] === "~=") return { min, width: min.length >= 3 ? 1 : 2 };
  if (version[2] !== undefined) return { min, width: Math.max(1, 3 - min.length) };
  return { min, width: 0 };
}

/** A requirement's specifier apart from its extras and environment marker. */
function pep440Parts(spec: string): { specifier: string; rest: string } {
  const [beforeMarker = "", ...marker] = spec.split(";");
  const extras = /^\s*\[[^\]]*\]/.exec(beforeMarker)?.[0] ?? "";
  return {
    specifier: beforeMarker.slice(extras.length),
    rest: `${extras.replace(/\s/g, "")};${marker.join(";").replace(/\s/g, "")}`,
  };
}

/** How far `to` moves from `from`, by the first release component that differs. */
function bumpLevel(from: number[], to: number[]): ChangeLevel {
  const length = Math.max(from.length, to.length, 3);
  // Before 1.0, each component is one step more significant (0.2 -> 0.3 breaks, as in semver).
  const significant = from.findIndex((part) => part !== 0);
  const shift = significant === -1 ? 2 : Math.min(significant, 2);
  for (let index = 0; index < length; index += 1) {
    const a = from[index] ?? 0;
    const b = to[index] ?? 0;
    if (a === b) continue;
    if (b < a) return "any";
    return LEVELS[Math.max(1, 3 - index + shift)] ?? "any";
  }
  return "none";
}

function rangeLevel(from: Range, to: Range): ChangeLevel {
  const bump = bumpLevel(from.min, to.min);
  const widened = to.width > from.width ? (LEVELS[to.width] ?? "any") : "none";
  const level = RANK[bump] >= RANK[widened] ? bump : widened;
  // Same lowest version and no wider: still a change (a narrower range, a pre-release tag).
  return level === "none" ? "patch" : level;
}

export function changeLevel(from: DependencySpec, to: DependencySpec): ChangeLevel {
  if (from.syntax === to.syntax && from.spec === to.spec) return "none";
  if (from.syntax !== to.syntax || from.syntax === "opaque") return "any";
  if (from.syntax === "npm") {
    const before = npmRange(from.spec);
    const after = npmRange(to.spec);
    return before === null || after === null ? "any" : rangeLevel(before, after);
  }
  const before = pep440Parts(from.spec);
  const after = pep440Parts(to.spec);
  if (before.rest !== after.rest) return "any";
  const oldRange = pep440Range(before.specifier);
  const newRange = pep440Range(after.specifier);
  if (oldRange === null || newRange === null) return "any";
  const same = before.specifier.replace(/\s/g, "") === after.specifier.replace(/\s/g, "");
  return same ? "none" : rangeLevel(oldRange, newRange);
}
