// SPEC §6.2 step 3: redacts secrets from a (cleaned) CI job log before it is stored or any model
// sees it. Pure: no I/O. Rules run most specific first; each replacement names its kind
// ([redacted:jwt]) so triage can still tell what was there. `redactText` from @pipeheal/shared runs
// last as a backstop, so this never catches less than what we redact from our own logs.
import { redactText } from "@pipeheal/shared";

export type RedactionKind =
  | "private-key"
  | "url-credentials"
  | "authorization"
  | "jwt"
  | "github-token"
  | "api-key"
  | "aws-access-key"
  | "assignment"
  | "high-entropy"
  | "other";

export interface RedactionResult {
  text: string;
  /** How many of each kind were redacted (only kinds that occurred; `other` is 1 or absent). */
  redactions: Partial<Record<RedactionKind, number>>;
}

const marker = (kind: RedactionKind) => `[redacted:${kind}]`;
const isMarker = (value: string) => value.startsWith("[redacted:");

/** A regex match: its text, and its capture groups ("" for a group that didn't take part). */
interface Match {
  text: string;
  group: (index: number) => string;
  has: (index: number) => boolean;
}

interface Rule {
  kind: RedactionKind;
  pattern: RegExp;
  /** The replacement for a match, or null to keep the match as it is. */
  replace: (match: Match) => string | null;
}

const whole =
  (kind: RedactionKind): Rule["replace"] =>
  () =>
    marker(kind);

// Key names whose values are secrets, in `KEY=value`, `key: value`, `"key": "value"`, `--key=value`.
const SECRET_KEY =
  "(?:secret|passw(?:or)?d|pwd|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|auth[_-]?key)";
// A key, possibly quoted, not starting mid-word; then `=` or a single `:` (never `::`, as in
// pytest node IDs like tests/test_token.py::test_refresh).
const ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9_.\-])(["']?)((?:--?)?[A-Za-z0-9_.\-]*${SECRET_KEY}[A-Za-z0-9_.\-]*)\1(\s*(?:=|(?<!:):(?!:))\s*)(?:"([^"\n]+)"|'([^'\n]+)'|([^\s,;'"]+))`,
  "gi",
);

const RULES: readonly Rule[] = [
  {
    // Through the END line, or to the end of the log when it was cut off inside the block.
    kind: "private-key",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    replace: whole("private-key"),
  },
  {
    // scheme://user:password@host keeps the user; scheme://TOKEN@host loses the token.
    kind: "url-credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)(?:([^\s/@:]*):([^\s/@]+)|([A-Za-z0-9_-]{20,}))@/gi,
    replace: (m) => {
      if (m.has(4)) return `${m.group(1)}${marker("url-credentials")}@`;
      if (isMarker(m.group(3))) return null;
      return `${m.group(1)}${m.group(2)}:${marker("url-credentials")}@`;
    },
  },
  {
    // Authorization headers, keeping the scheme: "Authorization: Bearer [redacted:...]".
    kind: "authorization",
    pattern:
      /\b((?:proxy-)?authorization)(\s*[:=]\s*)(?:(bearer|basic|token|digest)\s+)?([^\s"',;]+)/gi,
    replace: (m) => {
      const value = m.group(4);
      if (isMarker(value) || /^\*+$/.test(value)) return null;
      const scheme = m.has(3) ? `${m.group(3)} ` : "";
      return `${m.group(1)}${m.group(2)}${scheme}${marker("authorization")}`;
    },
  },
  {
    // "Bearer <credential>" anywhere; the credential must contain a digit, so prose after
    // "token" ("token validation failed") is left alone.
    kind: "authorization",
    pattern: /\b(bearer|token)\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{16,}/gi,
    replace: (m) => `${m.group(1)} ${marker("authorization")}`,
  },
  {
    kind: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
    replace: whole("jwt"),
  },
  {
    kind: "github-token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
    replace: whole("github-token"),
  },
  {
    // Anthropic/OpenAI (sk-), npm, Slack, Stripe, Google API keys.
    kind: "api-key",
    pattern:
      /\b(?:sk-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36,}|xox[abposr]-[A-Za-z0-9-]{10,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{35,})/g,
    replace: whole("api-key"),
  },
  {
    kind: "aws-access-key",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replace: whole("aws-access-key"),
  },
  {
    kind: "assignment",
    pattern: ASSIGNMENT,
    replace: (m) => {
      const value = m.group(4) || m.group(5) || m.group(6);
      // Already redacted, masked by GitHub (***), or a small number (a count, not a secret).
      if (isMarker(value) || /^\*+$/.test(value) || /^\d{1,15}$/.test(value)) return null;
      const quote = m.has(4) ? '"' : m.has(5) ? "'" : "";
      const key = `${m.group(1)}${m.group(2)}${m.group(1)}`;
      return `${key}${m.group(3)}${quote}${marker("assignment")}${quote}`;
    },
  },
  {
    // Long random-looking strings with no telling prefix: at least 32 characters, mixing upper
    // case, lower case and digits, with high Shannon entropy. Hex digests (commit SHAs, hashes)
    // have only two character classes and stay; so do long identifiers and paths.
    kind: "high-entropy",
    // `=` only as base64 padding at the end, so `NAME=value` is judged value by value.
    pattern: /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_=-])/g,
    replace: (m) => (looksRandom(m.text) ? marker("high-entropy") : null),
  },
];

const HIGH_ENTROPY_BITS = 4.3;

function looksRandom(value: string): boolean {
  const classes =
    Number(/[a-z]/.test(value)) + Number(/[A-Z]/.test(value)) + Number(/\d/.test(value));
  if (classes < 3) return false;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy >= HIGH_ENTROPY_BITS;
}

export function redactLog(text: string): RedactionResult {
  const redactions: Partial<Record<RedactionKind, number>> = {};
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (found: string, ...args: unknown[]) => {
      // replace() passes the groups, then the offset and the whole string.
      const groups = args.slice(0, -2);
      const replacement = rule.replace({
        text: found,
        group: (index) => {
          const group = groups[index - 1];
          return typeof group === "string" ? group : "";
        },
        has: (index) => typeof groups[index - 1] === "string",
      });
      if (replacement === null) return found;
      redactions[rule.kind] = (redactions[rule.kind] ?? 0) + 1;
      return replacement;
    });
  }
  const backstopped = withMarkersShielded(out, redactText);
  // `other`: the backstop found something no rule here did (e.g. a pre-signed URL's signature).
  if (backstopped !== out) redactions.other = 1;
  return { text: backstopped, redactions };
}

const MARKER = /\[redacted:[a-z-]+\]/g;
// A line separator (whitespace to every pattern) around a private-use character: the backstop's
// patterns never match across it, so they can't swallow a marker (e.g. taking
// "user:[redacted:url-credentials]@" for a password in a URL).
const SEPARATOR = String.fromCharCode(0x2028);
const PRIVATE_USE = String.fromCharCode(0xe000);
const SHIELD = new RegExp(`${SEPARATOR}${PRIVATE_USE}(\\d+)${PRIVATE_USE}${SEPARATOR}`, "g");

function withMarkersShielded(text: string, transform: (text: string) => string): string {
  const markers: string[] = [];
  const shielded = text.replace(MARKER, (found) => {
    markers.push(found);
    return `${SEPARATOR}${PRIVATE_USE}${String(markers.length - 1)}${PRIVATE_USE}${SEPARATOR}`;
  });
  return transform(shielded).replace(
    SHIELD,
    (_found, index: string) => markers[Number(index)] ?? "",
  );
}
