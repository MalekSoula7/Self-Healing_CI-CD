// Dependency manifests and lockfiles (SPEC §8.5): package.json, requirements files, pyproject.toml
// and Pipfile, read into one entry per dependency, keyed by section and (normalized) name. Pure.
// Settings that move versions without naming a package (overrides, index URLs, sources) are
// entries too, so changing them is a dependency change.
import { parse as parseToml } from "smol-toml";
import { at, stripCode } from "./source";
import { isRegistryNpmSpec, type DependencySpec } from "./versions";

export interface Dependency extends DependencySpec {
  /** Adding a `package` is governed by `dependencies.allowNew`; any change to a `setting` needs `any`. */
  kind: "package" | "setting";
}

export type ManifestRead =
  { ok: true; dependencies: Map<string, Dependency> } | { ok: false; error: string };

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** JSON with object keys sorted at every depth, for comparing parsed values. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (nested === null || typeof nested !== "object" || Array.isArray(nested)) return nested;
    if (nested instanceof Date) return nested.toISOString();
    const record = nested as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function basename(path: string): string {
  return (path.split("/").pop() ?? path).toLowerCase();
}

export type Ecosystem = "npm" | "python";

const LOCKFILES: Record<string, Ecosystem> = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "yarn.lock": "npm",
  "pnpm-lock.yaml": "npm",
  "bun.lock": "npm",
  "bun.lockb": "npm",
  "deno.lock": "npm",
  "poetry.lock": "python",
  "uv.lock": "python",
  "pipfile.lock": "python",
  "pdm.lock": "python",
  "pixi.lock": "python",
};

/** The ecosystem whose lockfile `path` is, or null. */
export function lockfileEcosystem(path: string): Ecosystem | null {
  const name = basename(path);
  if (/^pylock(\.[^.]+)?\.toml$/.test(name) || /^requirements.*\.lock$/.test(name)) return "python";
  if (name === "conda-lock.yml" || name === "conda-lock.yaml") return "python";
  return LOCKFILES[name] ?? null;
}

export function isLockfile(path: string): boolean {
  return lockfileEcosystem(path) !== null;
}

/**
 * Files that move dependency versions or sources without being a manifest we read: workspace
 * catalogs and overrides, registry settings, install hooks, patches to installed packages,
 * conda environments, setup.py/setup.cfg, and toolchain pins. Any change to one needs mode `any`.
 */
export function isDependencySettingsFile(path: string): boolean {
  const name = basename(path);
  return (
    /^(pnpm-workspace\.yaml|\.npmrc|\.yarnrc(\.yml)?|\.pnpmfile\.[cm]?js|environment\.ya?ml|setup\.cfg|\.nvmrc|\.node-version|\.python-version|\.tool-versions|pixi\.toml|uv\.toml|pdm\.toml|bunfig\.toml|import_map\.json|package\.ya?ml|package\.json5)$/.test(
      name,
    ) || /\.(patch|diff)$/i.test(name)
  );
}

/**
 * A spec that installs from somewhere other than the registry under the package's own name: an
 * allowlist, so `exec:`, `jsr:`, `workspace:`, git, file and alias specs all count (P3.6).
 */
export function isForeignSource(dependency: Dependency): boolean {
  if (dependency.syntax === "pep440") return false;
  if (dependency.syntax === "opaque") return true;
  return !isRegistryNpmSpec(dependency.spec);
}

/** The ecosystem of the manifest at `path` (call only for manifests). */
export function manifestEcosystem(path: string): Ecosystem {
  return basename(path) === "package.json" ? "npm" : "python";
}

const setting = (value: unknown): Dependency => ({
  syntax: "opaque",
  spec: stableJson(value),
  kind: "setting",
});

/** PEP 503 name normalization. */
function pythonName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** A PEP 508 requirement: its name, and the rest (extras, specifier, marker) as its spec. */
function requirement(text: string): [string, Dependency] {
  const match = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(.*)$/s.exec(text);
  if (match === null) return [text.trim(), setting(text.trim())];
  const rest = (match[2] ?? "").trim();
  const name = pythonName(match[1] ?? "");
  if (rest.startsWith("@")) return [name, { syntax: "opaque", spec: rest, kind: "package" }];
  return [name, { syntax: "pep440", spec: rest, kind: "package" }];
}

function readPackageJson(json: Record<string, unknown>): Map<string, Dependency> {
  const dependencies = new Map<string, Dependency>();
  for (const section of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const entries = json[section];
    if (entries === undefined) continue;
    if (!isRecord(entries)) {
      dependencies.set(section, setting(entries));
      continue;
    }
    for (const [name, spec] of Object.entries(entries)) {
      dependencies.set(
        `${section}:${name}`,
        typeof spec === "string"
          ? { syntax: "npm", spec, kind: "package" }
          : { syntax: "opaque", spec: stableJson(spec), kind: "package" },
      );
    }
  }
  const settings = [
    "overrides",
    "resolutions",
    "pnpm",
    "bundleDependencies",
    "bundledDependencies",
    "packageManager",
    "trustedDependencies",
    "volta",
    "engines",
    "devEngines",
  ];
  for (const key of settings) {
    if (json[key] !== undefined) dependencies.set(key, setting(json[key]));
  }
  return dependencies;
}

function readRequirements(content: string): Map<string, Dependency> {
  const dependencies = new Map<string, Dependency>();
  for (const raw of content.replace(/\\\r?\n/g, "").split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (line === "") continue;
    if (line.startsWith("-")) {
      dependencies.set(`option:${line}`, { syntax: "opaque", spec: line, kind: "setting" });
    } else {
      const [name, dependency] = requirement(line);
      const earlier = dependencies.get(name);
      // A name listed twice: keep both, so a change to either is seen (and needs `any`).
      dependencies.set(
        name,
        earlier === undefined
          ? dependency
          : { syntax: "opaque", spec: `${earlier.spec} && ${dependency.spec}`, kind: "package" },
      );
    }
  }
  return dependencies;
}

/** A Poetry or Pipfile value: a string spec, or a table with only `version`; else opaque. */
function tableSpec(value: unknown, pipfile: boolean): Dependency {
  const spec = isRecord(value) && Object.keys(value).length === 1 ? value.version : value;
  if (typeof spec !== "string")
    return { syntax: "opaque", spec: stableJson(value), kind: "package" };
  const trimmed = spec.trim();
  if (pipfile) return { syntax: "pep440", spec: trimmed === "*" ? "" : trimmed, kind: "package" };
  // Poetry: ^, ~ (not ~=), bare versions and * read like npm ranges; operators like PEP 440.
  const npmLike = /^(\^|~(?!=)|\*$|\d)/.test(trimmed);
  return { syntax: npmLike ? "npm" : "pep440", spec: trimmed, kind: "package" };
}

function addRequirementList(into: Map<string, Dependency>, section: string, list: unknown): void {
  if (!Array.isArray(list)) {
    if (list !== undefined) into.set(section, setting(list));
    return;
  }
  for (const item of list) {
    if (typeof item === "string") {
      const [name, dependency] = requirement(item);
      into.set(`${section}:${name}`, dependency);
    } else {
      into.set(`${section}:${stableJson(item)}`, setting(item));
    }
  }
}

function addTable(
  into: Map<string, Dependency>,
  section: string,
  table: unknown,
  pipfile: boolean,
): void {
  if (!isRecord(table)) {
    if (table !== undefined) into.set(section, setting(table));
    return;
  }
  for (const [name, value] of Object.entries(table)) {
    const key = `${section}:${pipfile || name === "python" ? name : pythonName(name)}`;
    into.set(key, name === "python" ? setting(value) : tableSpec(value, pipfile));
  }
}

function child(record: unknown, ...keys: string[]): unknown {
  let value: unknown = record;
  for (const key of keys) value = isRecord(value) ? value[key] : undefined;
  return value;
}

function eachTable(value: unknown): [string, unknown][] {
  return isRecord(value) ? Object.entries(value) : [];
}

function readPyproject(toml: Record<string, unknown>): Map<string, Dependency> {
  const dependencies = new Map<string, Dependency>();
  addRequirementList(dependencies, "build-system", child(toml, "build-system", "requires"));
  addRequirementList(dependencies, "project", child(toml, "project", "dependencies"));
  for (const [group, list] of eachTable(child(toml, "project", "optional-dependencies"))) {
    addRequirementList(dependencies, `project.optional-dependencies.${group}`, list);
  }
  for (const [group, list] of eachTable(child(toml, "dependency-groups"))) {
    addRequirementList(dependencies, `dependency-groups.${group}`, list);
  }
  const poetry = ["tool", "poetry"];
  addTable(dependencies, "tool.poetry.dependencies", child(toml, ...poetry, "dependencies"), false);
  addTable(
    dependencies,
    "tool.poetry.dev-dependencies",
    child(toml, ...poetry, "dev-dependencies"),
    false,
  );
  for (const [group, value] of eachTable(child(toml, ...poetry, "group"))) {
    addTable(
      dependencies,
      `tool.poetry.group.${group}.dependencies`,
      child(value, "dependencies"),
      false,
    );
  }
  addRequirementList(
    dependencies,
    "tool.uv.dev-dependencies",
    child(toml, "tool", "uv", "dev-dependencies"),
  );
  for (const [group, list] of eachTable(child(toml, "tool", "pdm", "dev-dependencies"))) {
    addRequirementList(dependencies, `tool.pdm.dev-dependencies.${group}`, list);
  }
  // Where packages come from.
  for (const [key, value] of [
    ["tool.poetry.source", child(toml, ...poetry, "source")],
    ["tool.uv.sources", child(toml, "tool", "uv", "sources")],
    ["tool.uv.index", child(toml, "tool", "uv", "index")],
    ["tool.pdm.resolution", child(toml, "tool", "pdm", "resolution")],
    ["tool.uv.override-dependencies", child(toml, "tool", "uv", "override-dependencies")],
    ["tool.uv.constraint-dependencies", child(toml, "tool", "uv", "constraint-dependencies")],
  ] as const) {
    if (value !== undefined) dependencies.set(key, setting(value));
  }
  return dependencies;
}

function readPipfile(toml: Record<string, unknown>): Map<string, Dependency> {
  const dependencies = new Map<string, Dependency>();
  addTable(dependencies, "packages", toml.packages, true);
  addTable(dependencies, "dev-packages", toml["dev-packages"], true);
  if (toml.source !== undefined) dependencies.set("source", setting(toml.source));
  return dependencies;
}

type Reader = (content: string) => Map<string, Dependency>;

function parsedJson(content: string): Record<string, unknown> {
  const value: Json = JSON.parse(content) as Json;
  if (!isRecord(value)) throw new Error("not a JSON object");
  return value;
}

const SETUP_ARGUMENTS = [
  "install_requires",
  "extras_require",
  "setup_requires",
  "tests_require",
  "python_requires",
];

/** End of a Python expression starting at `start` in `code` (strings blanked): bracket-balanced. */
function expressionEnd(code: string, start: number): number {
  let depth = 0;
  let end = start;
  for (; end < code.length; end += 1) {
    const char = code[end];
    if (char === "[" || char === "(" || char === "{") depth += 1;
    else if (char === "]" || char === ")" || char === "}") depth -= 1;
    if ((depth === 0 && (char === "," || char === "\n")) || depth < 0) break;
  }
  return end;
}

/** The value text of `name = ...` (keyword argument or assignment) at each place it's set. */
function valuesOf(content: string, code: string, pattern: RegExp): string[] {
  return [...code.matchAll(pattern)].map((match) => {
    const start = match.index + match[0].length;
    return content.slice(start, expressionEnd(code, start)).trim();
  });
}

/**
 * setup.py is code. Its dependency arguments are found in the code (comments blanked, so a comment
 * naming `install_requires=` doesn't count), an identifier argument is followed to its assignment,
 * and a literal list of requirement strings is read requirement by requirement (so a patch bump
 * is a patch). Anything else is one setting, so changing it needs mode `any`. The rest of the
 * file isn't dependencies at all.
 */
function readSetupPy(content: string): Map<string, Dependency> {
  const code = stripCode(content, "python");
  const dependencies = new Map<string, Dependency>();
  for (const argument of SETUP_ARGUMENTS) {
    const values = valuesOf(content, code, new RegExp(`\\b${argument}\\s*=(?!=)`, "g"));
    values.forEach((written, occurrence) => {
      const key = `setup.py:${argument}${occurrence === 0 ? "" : `#${String(occurrence + 1)}`}`;
      const identifier = /^[A-Za-z_]\w*$/.test(written) ? written : null;
      // A list grown elsewhere (`REQUIREMENTS.append(...)`, `BASE + EXTRA`) can't be read here:
      // the whole file is then the setting.
      const mutated =
        identifier !== null &&
        new RegExp(
          `\\b${identifier}\\s*(\\.\\s*(append|extend|insert|__iadd__)\\s*\\(|\\+=|\\+)|\\+\\s*${identifier}\\b`,
        ).test(code);
      if (mutated) {
        dependencies.set(key, setting(content));
        return;
      }
      const value =
        identifier === null
          ? written
          : (valuesOf(content, code, new RegExp(`^\\s*${identifier}\\s*=(?!=)`, "gm")).at(-1) ??
            written);
      const strings = [...value.matchAll(/(["'])((?:(?!\1)[^\\\n])*)\1/g)].map((match) =>
        at(match, 2),
      );
      const rest = value.replace(/(["'])((?:(?!\1)[^\\\n])*)\1/g, "").replace(/[\s,]/g, "");
      if (/^[[(]/.test(value) && /^[[(][\])]$/.test(rest)) {
        for (const text of strings) {
          const [name, dependency] = requirement(text);
          dependencies.set(`${key}:${name}`, dependency);
        }
      } else {
        dependencies.set(key, setting(value.replace(/\s+/g, " ")));
      }
    });
  }
  return dependencies;
}

const REQUIREMENT_LINE = /^([A-Za-z0-9][A-Za-z0-9._-]*\s*(\[[^\]]*\])?\s*([<>=!~;@(].*)?|-.*)$/;

/** Every non-comment line reads as a requirement or an option. */
function looksLikeRequirements(content: string): boolean {
  return content
    .replace(/\\\r?\n/g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "").trim())
    .every((line) => line === "" || REQUIREMENT_LINE.test(line));
}

function readerFor(path: string): Reader | null {
  const name = basename(path);
  if (name === "package.json") return (content) => readPackageJson(parsedJson(content));
  if (name === "pyproject.toml") return (content) => readPyproject(parseToml(content));
  if (name === "pipfile") return (content) => readPipfile(parseToml(content));
  if (name === "setup.py") return readSetupPy;
  const requirements =
    /(requirements|constraints).*\.(txt|in)$/.test(name) ||
    /(^|\/)requirements\/[^/]+\.(txt|in)$/i.test(path);
  return requirements ? readRequirements : null;
}

/**
 * Files named like requirements but not starting with it (`docs/system_requirements.txt`) are
 * manifests only when they read as one; `requirements*`/`constraints*` always are.
 */
function lenientName(path: string): boolean {
  const name = basename(path);
  const strict =
    /^(requirements|constraints)/.test(name) ||
    /^(dev|test|tests|testing|doc|docs|lint|ci|prod|production|base|local|extra|extras|optional|build|runtime|common)[-_.](requirements|constraints)/.test(
      name,
    ) ||
    /(^|\/)requirements\//i.test(path);
  return !strict;
}

/** The dependencies a manifest declares; null when `path` isn't a manifest. */
export function readManifest(path: string, content: string): ManifestRead | null {
  const reader = readerFor(path);
  if (reader === null) return null;
  if (reader === readRequirements && lenientName(path) && !looksLikeRequirements(content))
    return null;
  try {
    return { ok: true, dependencies: reader(content) };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}
