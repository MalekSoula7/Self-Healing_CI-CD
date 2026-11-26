// protectedConfigs (SPEC §8.5): the configuration of the checks CI runs (tests, lint, format,
// types, coverage). Whole files by name; package.json and pyproject.toml by section, parsed (a
// header inside a string can't move a key out of [tool.*]). Their dependency sections are
// dependencies.*'s; a file that doesn't parse is reported there.
import { parse as parseToml } from "smol-toml";
import { globList } from "../glob";
import { stableJson } from "../manifests";
import { pathsOf, type Check, type Violation } from "./types";

export const PROTECTED_CONFIG_GLOBS: readonly string[] = [
  // TypeScript
  "**/tsconfig*.json",
  "**/jsconfig*.json",
  // Test runners and coverage (second configs too: jest.unit.config.js, playwright-ct.config.ts)
  "**/{jest,vitest,vite,playwright,cypress,ava}*.config.*",
  "**/*jest*.json",
  "**/vitest.workspace.*",
  "**/karma.conf.*",
  "**/.mocharc*",
  "**/.nycrc*",
  "**/.c8rc*",
  "**/{.,}codecov.y{a,}ml",
  // Transforms test code
  "**/babel.config.*",
  "**/.babelrc*",
  // Task runners that define what CI runs
  "**/turbo.json",
  "**/nx.json",
  "**/{Makefile,makefile,GNUmakefile,justfile,Justfile}",
  "**/Taskfile.y{a,}ml",
  "**/.pre-commit-config.y{a,}ml",
  "**/deno.json{,c}",
  // Local actions (`uses: ./path`) are CI code; protected here rather than an invariant, so a
  // repository that is itself an action can still be healed when an admin allows it.
  "**/action.y{a,}ml",
  // Build configs that can switch type checks or lint off (ignoreBuildErrors, a dropped plugin).
  "**/{next,nuxt,astro,svelte,remix,webpack,rollup,tsup,rspack,esbuild,rsbuild}.config.*",
  "**/angular.json",
  "**/.editorconfig",
  // Other linters CI runs, and runner configs.
  "**/{.,}cspell.json",
  "**/cspell.config.*",
  "**/.markdownlint*",
  "**/.yamllint*",
  "**/.shellcheckrc",
  "**/{.,}knip.json{,c}",
  "**/knip.config.*",
  "**/hatch.toml",
  "**/wdio.conf.*",
  "**/jasmine.json",
  "**/.size-limit*",
  "**/.swcrc",
  "**/sonar-project.properties",
  "**/{commitlint.config.*,.commitlintrc*}",
  // Lint and format
  "**/eslint.config.*",
  "**/.eslintrc*",
  "**/.eslintignore",
  "**/.prettierrc*",
  "**/prettier.config.*",
  "**/.prettierignore",
  "**/biome.json",
  "**/biome.jsonc",
  "**/.stylelintrc*",
  "**/.stylelintignore",
  "**/stylelint.config.*",
  // Python
  "**/{.,}pytest.ini",
  "**/setup.cfg",
  "**/tox.ini",
  "**/noxfile.py",
  "**/.coveragerc",
  "**/mypy.ini",
  "**/.mypy.ini",
  "**/.flake8",
  "**/ruff.toml",
  "**/.ruff.toml",
  "**/.pylintrc",
  "**/pylintrc",
  "**/pyrightconfig.json",
];

/** package.json keys that configure a check. */
const PACKAGE_JSON_KEYS = [
  "scripts",
  "jest",
  "eslintConfig",
  "eslintIgnore",
  "prettier",
  "stylelint",
  "ava",
  "mocha",
  "nyc",
  "c8",
  "xo",
  "standard",
  "tsd",
  "vitest",
  "lint-staged",
  "husky",
  // The report the behavioral checks read, the transform, and which packages exist at all.
  "jest-junit",
  "babel",
  "workspaces",
  "size-limit",
  "knip",
  "browserslist",
  "cspell",
];

/** pyproject.toml [tool.*] tables that are dependencies, not configuration. */
const PYPROJECT_DEPENDENCY_KEYS: Record<string, readonly string[]> = {
  poetry: ["dependencies", "dev-dependencies", "group", "source"],
  uv: ["dev-dependencies", "sources", "index"],
  pdm: ["dev-dependencies"],
};

const protectedFiles = globList(PROTECTED_CONFIG_GLOBS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function basename(path: string): string {
  return (path.split("/").pop() ?? path).toLowerCase();
}

/** The protected part of a package.json or pyproject.toml, or null if it doesn't parse. */
function protectedPart(path: string, content: string | null): unknown {
  // An absent file reads as an empty one: adding a package.json without scripts changes nothing here.
  const text = content ?? (basename(path) === "package.json" ? "{}" : "");
  try {
    if (basename(path) === "package.json") {
      const json: unknown = JSON.parse(text);
      if (!isRecord(json)) return null;
      return Object.fromEntries(PACKAGE_JSON_KEYS.map((key) => [key, json[key] ?? null]));
    }
    const toml = parseToml(text);
    // A Pipfile's [scripts] are the commands `pipenv run` runs, tests included.
    if (basename(path) === "pipfile") return { scripts: toml.scripts ?? null };
    const project = toml.project;
    const entryPoints = isRecord(project) ? project["entry-points"] : undefined;
    // pytest11 entry points load pytest plugins.
    const plugins = isRecord(entryPoints) ? (entryPoints.pytest11 ?? null) : null;
    const tool = toml.tool;
    if (!isRecord(tool)) return { plugins, settings: {} };
    const settings = Object.fromEntries(
      Object.entries(tool).flatMap(([name, table]): [string, unknown][] => {
        if (!isRecord(table)) return [[name, table]];
        const skip = PYPROJECT_DEPENDENCY_KEYS[name] ?? [];
        const settings = Object.entries(table).filter(([key]) => !skip.includes(key));
        // A table holding only dependencies configures nothing.
        return settings.length === 0 ? [] : [[name, Object.fromEntries(settings)]];
      }),
    );
    return { plugins, settings };
  } catch {
    return null;
  }
}

function sectionChanged(
  path: string,
  oldPath: string,
  before: string | null,
  after: string | null,
) {
  const old = protectedPart(oldPath, before);
  const next = protectedPart(path, after);
  return old !== null && next !== null && stableJson(old) !== stableJson(next);
}

export const checkConfigs: Check = (changes, { policy }) => {
  if (!policy.protectedConfigs) return [];
  const violations: Violation[] = [];
  for (const change of changes) {
    const path = pathsOf(change).find((candidate) => protectedFiles.matchAnywhere(candidate));
    const sectioned = ["package.json", "pyproject.toml", "pipfile"].includes(basename(change.path));
    if (path !== undefined) {
      violations.push({
        ruleId: "protectedConfigs",
        path,
        message: `${path} configures a check CI runs, and the policy protects it.`,
        hint: "Fix the code so the checks pass as configured; don't change how they run.",
      });
    } else if (
      sectioned &&
      sectionChanged(
        change.path,
        change.oldPath ?? change.path,
        change.oldContent,
        change.newContent,
      )
    ) {
      violations.push({
        ruleId: "protectedConfigs",
        path: change.path,
        message: `${change.path}: a section that configures a check CI runs changed (scripts, or tool settings).`,
        hint: "Fix the code so the checks pass as configured; don't change scripts or [tool.*] settings.",
      });
    }
  }
  return violations;
};
