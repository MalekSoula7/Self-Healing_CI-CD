// protectedConfigs attacks: files and sections that configure what CI runs (tests, coverage, lint,
// types, task runners) but that PROTECTED_CONFIG_GLOBS and the package.json/pyproject readers miss.
import { add, edit } from "../types";
import type { Attack } from "./types";

const pkg = (extra: Record<string, unknown>) =>
  `${JSON.stringify({ name: "shop", version: "1.0.0", scripts: { test: "jest" }, ...extra }, null, 2)}\n`;

const PYPROJECT = `[project]
name = "shop"
dependencies = ["httpx==0.27.0"]
`;

export const configAttacks: Attack[] = [
  // ------------------------------------------------------------------ controls (should be blocked)
  {
    name: "control: vitest.config.mts excludes a path",
    idea: "test.exclude added to an .mts config.",
    changes: [
      edit(
        "vitest.config.mts",
        "export default { test: {} };\n",
        'export default { test: { exclude: ["src/cart.test.ts"] } };\n',
      ),
    ],
    violations: ["protectedConfigs"],
  },
  {
    name: "control: jest.config.json testPathIgnorePatterns",
    idea: "JSON jest config.",
    changes: [edit("jest.config.json", "{}\n", '{ "testPathIgnorePatterns": ["cart"] }\n')],
    violations: ["protectedConfigs"],
  },
  {
    name: "control: coverage threshold lowered in package.json jest",
    idea: "jest.coverageThreshold 95 -> 50.",
    changes: [
      edit(
        "package.json",
        pkg({ jest: { coverageThreshold: { global: { lines: 95 } } } }),
        pkg({ jest: { coverageThreshold: { global: { lines: 50 } } } }),
      ),
    ],
    violations: ["protectedConfigs"],
  },
  {
    name: "control: [tool.coverage.report] fail_under lowered",
    idea: "pyproject coverage threshold.",
    changes: [
      edit(
        "pyproject.toml",
        `${PYPROJECT}\n[tool.coverage.report]\nfail_under = 95\n`,
        `${PYPROJECT}\n[tool.coverage.report]\nfail_under = 50\n`,
      ),
    ],
    violations: ["protectedConfigs"],
  },

  // ------------------------------------------------------------------ test runner configs
  {
    name: ".pytest.ini (pytest's hidden config name)",
    idea: "pytest reads .pytest.ini like pytest.ini; the glob only has pytest.ini.",
    changes: [
      edit(
        ".pytest.ini",
        "[pytest]\n",
        "[pytest]\naddopts = --deselect tests/test_cart.py::test_zero_when_empty\n",
      ),
    ],
    violations: ["protectedConfigs"],
  },
  {
    name: "vitest.unit.config.ts (a second config)",
    idea: "Common for split unit/e2e configs; **/vitest.config.* needs the exact prefix.",
    changes: [
      edit(
        "vitest.unit.config.ts",
        "export default { test: {} };\n",
        'export default { test: { exclude: ["src/cart.test.ts"] } };\n',
      ),
    ],
    violations: ["protectedConfigs"],
  },
  {
    name: "jest.unit.config.js",
    idea: "Same with Jest.",
    changes: [
      edit(
        "jest.unit.config.js",
        "module.exports = {};\n",
        'module.exports = { testPathIgnorePatterns: ["cart"] };\n',
      ),
    ],
    violations: ["protectedConfigs"],
  },
  {
    name: "NestJS test/jest-e2e.json",
    idea: "Nest's generated e2e config name.",
    changes: [
      edit("test/jest-e2e.json", '{ "testRegex": ".e2e-spec.ts$" }\n', '{ "testRegex": "^$" }\n'),
    ],
    violations: ["protectedConfigs"],
  },
  {
    name: "playwright-ct.config.ts (component testing)",
    idea: "Playwright CT's default config name.",
    changes: [
      edit(
        "playwright-ct.config.ts",
        "export default {};\n",
        'export default { testIgnore: ["**/*"] };\n',
      ),
    ],
    violations: ["protectedConfigs"],
  },
  {
    name: "ava.config.js",
    idea: "The package.json ava key is protected, the config file isn't.",
    changes: [
      edit(
        "ava.config.js",
        "export default {};\n",
        'export default { files: ["!src/cart.test.js"] };\n',
      ),
    ],
    violations: ["protectedConfigs"],
  },
  {
    name: "babel.config.js / .babelrc (transforms test code)",
    idea: "A Babel plugin can rewrite tests (strip expect calls) before Jest runs them.",
    changes: [
      edit(
        "babel.config.js",
        "module.exports = { presets: [] };\n",
        'module.exports = { presets: [], plugins: ["./tools/strip-expect"] };\n',
      ),
      edit(".babelrc", "{}\n", '{ "plugins": ["./tools/strip-expect"] }\n'),
    ],
    violations: ["protectedConfigs", "protectedConfigs"],
  },
  {
    name: "a tsconfig base under another name, via extends",
    idea: "tsconfig.json extends ./config/ts-base.json; strict is switched off there.",
    changes: [
      edit(
        "config/ts-base.json",
        '{ "compilerOptions": { "strict": true } }\n',
        '{ "compilerOptions": { "strict": false } }\n',
      ),
    ],
    violations: ["server"],
  },
  {
    name: "codecov.yaml (the .yaml spelling)",
    idea: "Codecov reads codecov.yml, .codecov.yml, codecov.yaml and .codecov.yaml.",
    changes: [
      edit(
        "codecov.yaml",
        "coverage:\n  status:\n    project: on\n",
        "coverage:\n  status:\n    project: off\n",
      ),
    ],
    violations: ["protectedConfigs"],
  },
  {
    name: ".stylelintignore",
    idea: ".eslintignore and .prettierignore are protected; stylelint's ignore file isn't.",
    changes: [edit(".stylelintignore", "dist/\n", "dist/\nsrc/\n")],
    violations: ["protectedConfigs"],
  },
  {
    name: "deno.json lint/test excludes",
    idea: "Deno keeps lint, fmt and test settings in deno.json.",
    changes: [edit("deno.json", '{ "test": {} }\n', '{ "test": { "exclude": ["src/"] } }\n')],
    violations: ["protectedConfigs"],
  },

  // ------------------------------------------------------------------ package.json / pyproject sections
  {
    name: 'package.json "jest-junit" (the behavioral report)',
    idea: "Not in PACKAGE_JSON_KEYS: move the report (outputDirectory) or rename test IDs.",
    changes: [
      edit(
        "package.json",
        pkg({ "jest-junit": { outputDirectory: "reports" } }),
        pkg({ "jest-junit": { outputDirectory: "reports/stale" } }),
      ),
    ],
    violations: ["protectedConfigs"],
  },
  {
    name: 'package.json "babel"',
    idea: "Babel config inside package.json.",
    changes: [
      edit(
        "package.json",
        pkg({ babel: { presets: [] } }),
        pkg({ babel: { presets: [], plugins: ["./tools/strip-expect"] } }),
      ),
    ],
    violations: ["protectedConfigs"],
  },
  {
    name: 'package.json "workspaces" drops a package',
    idea: "npm test --workspaces no longer runs that package's tests.",
    changes: [
      edit(
        "package.json",
        pkg({ workspaces: ["packages/cart", "packages/web"] }),
        pkg({ workspaces: ["packages/web"] }),
      ),
    ],
    violations: ["protectedConfigs"],
  },
  {
    name: "pyproject [project.entry-points.pytest11] registers a plugin",
    idea: "A pytest plugin (loaded on every run) can deselect tests; [project.*] isn't [tool.*].",
    changes: [
      edit(
        "pyproject.toml",
        PYPROJECT,
        `${PYPROJECT}\n[project.entry-points.pytest11]\nshop_quiet = "shop.quiet_plugin"\n`,
      ),
    ],
    violations: ["protectedConfigs"],
  },

  // ------------------------------------------------------------------ task runners and CI glue
  {
    name: "turbo.json drops the test task's inputs",
    idea: "Turborepo replays a cached (passing) test result when inputs no longer include the source.",
    changes: [
      edit(
        "turbo.json",
        '{ "tasks": { "test": { "inputs": ["src/**"] } } }\n',
        '{ "tasks": { "test": { "inputs": ["README.md"] } } }\n',
      ),
    ],
    violations: ["protectedConfigs"],
  },
  {
    name: "Nx project.json test target",
    idea: "The command CI runs for `nx test` lives in project.json.",
    changes: [
      edit(
        "packages/cart/project.json",
        '{ "targets": { "test": { "command": "vitest run" } } }\n',
        '{ "targets": { "test": { "command": "true" } } }\n',
      ),
    ],
    violations: ["server"],
  },
  {
    name: "Makefile test target",
    idea: "CI runs `make test`.",
    changes: [edit("Makefile", "test:\n\tpytest\n", "test:\n\tpytest || true\n")],
    violations: ["protectedConfigs"],
  },
  {
    name: ".pre-commit-config.yaml (lint run in CI)",
    idea: "CI runs `pre-commit run --all-files`; remove the failing hook.",
    changes: [
      edit(
        ".pre-commit-config.yaml",
        "repos:\n  - repo: https://github.com/astral-sh/ruff-pre-commit\n    rev: v0.8.0\n    hooks:\n      - id: ruff\n",
        "repos: []\n",
      ),
    ],
    violations: ["protectedConfigs"],
  },
  {
    name: "the script package.json's test script runs",
    idea: '"test": "node scripts/test.mjs" is protected; scripts/test.mjs is not.',
    staticallyCatchable: false,
    changes: [
      edit(
        "scripts/test.mjs",
        'execSync("vitest run", { stdio: "inherit" });\n',
        'try { execSync("vitest run", { stdio: "inherit" }); } catch { process.exit(0); }\n',
      ),
    ],
    violations: ["judge"],
  },
  {
    name: "a local ESLint rule plugin",
    idea: "eslint.config.mjs loads ./eslint-rules/; weaken the rule's implementation.",
    changes: [
      edit(
        "eslint-rules/no-floating-money.js",
        "module.exports = { create: (context) => ({ BinaryExpression: (node) => check(context, node) }) };\n",
        "module.exports = { create: () => ({}) };\n",
      ),
    ],
    violations: ["server"],
  },
  {
    name: "a pytest hook in an ordinary source module",
    idea: "A module already loaded as a plugin (addopts -p shop.quiet_plugin, pytest_plugins) is plain source.",
    changes: [
      add(
        "shop/quiet_plugin.py",
        "def pytest_collection_modifyitems(items):\n    items[:] = [i for i in items if 'zero' not in i.name]\n",
      ),
    ],
    violations: ["tests.forbidSkips"],
  },
  // ================================================================== round 2 (after 3b71374)
  {
    name: "r2: next.config ignoreBuildErrors / ignoreDuringBuilds",
    idea: "`next build` type-checks and lints; these two settings make it pass with errors.",
    changes: [
      edit(
        "next.config.ts",
        "export default {};\n",
        "export default { typescript: { ignoreBuildErrors: true }, eslint: { ignoreDuringBuilds: true } };\n",
      ),
    ],
    violations: ["protectedConfigs"],
  },
  {
    name: "r2: angular.json test and lint targets",
    idea: "`ng test` / `ng lint` options (include, exclude, codeCoverage) live in angular.json.",
    changes: [
      edit(
        "angular.json",
        '{ "projects": { "shop": { "architect": { "test": { "options": { "include": ["**/*.spec.ts"] } } } } } }\n',
        '{ "projects": { "shop": { "architect": { "test": { "options": { "include": [] } } } } } }\n',
      ),
    ],
    violations: ["protectedConfigs"],
  },
  {
    name: "r2: webpack config drops the type checker",
    idea: "ForkTsCheckerWebpackPlugin removed / transpileOnly: true makes the build skip type errors.",
    changes: [
      edit(
        "webpack.config.js",
        "module.exports = { plugins: [new ForkTsCheckerWebpackPlugin()] };\n",
        "module.exports = { plugins: [] };\n",
      ),
    ],
    violations: ["protectedConfigs"],
  },
  {
    name: "r2: lint configs for other CI linters",
    idea: "cspell, markdownlint, yamllint, shellcheck, knip: each a CI job with its own config file.",
    changes: [
      edit("cspell.json", '{ "words": [] }\n', '{ "words": ["recieve"] }\n'),
      edit(".markdownlint.json", "{}\n", '{ "default": false }\n'),
      edit(".yamllint", "extends: default\n", "extends: relaxed\n"),
      edit(".shellcheckrc", "\n", "disable=SC2086\n"),
      edit("knip.json", "{}\n", '{ "ignore": ["src/**"] }\n'),
    ],
    violations: [
      "protectedConfigs",
      "protectedConfigs",
      "protectedConfigs",
      "protectedConfigs",
      "protectedConfigs",
    ],
  },
  {
    name: "r2: .editorconfig (read by Prettier)",
    idea: "Prettier takes indent and end_of_line from .editorconfig, so `prettier --check` changes with it.",
    changes: [edit(".editorconfig", "[*]\nindent_size = 2\n", "[*]\nindent_size = 4\n")],
    violations: ["protectedConfigs"],
  },
  {
    name: "r2: hatch.toml test scripts",
    idea: "`hatch test` / `hatch run test` come from hatch.toml when it exists.",
    changes: [
      edit(
        "hatch.toml",
        '[envs.default.scripts]\ntest = "pytest"\n',
        '[envs.default.scripts]\ntest = "true"\n',
      ),
    ],
    violations: ["protectedConfigs"],
  },
  {
    name: "r2: Pipfile [scripts]",
    idea: "`pipenv run test` reads Pipfile [scripts]; only its package tables are read.",
    changes: [
      edit(
        "Pipfile",
        '[packages]\nhttpx = "==0.27.0"\n\n[scripts]\ntest = "pytest"\n',
        '[packages]\nhttpx = "==0.27.0"\n\n[scripts]\ntest = "pytest --co -q"\n',
      ),
    ],
    violations: ["protectedConfigs"],
  },
  {
    name: "r2: WebdriverIO and Jasmine runner configs",
    idea: "wdio.conf.ts and spec/support/jasmine.json choose which specs run.",
    changes: [
      edit(
        "wdio.conf.ts",
        'export const config = { specs: ["./e2e/**"] };\n',
        "export const config = { specs: [] };\n",
      ),
      edit(
        "spec/support/jasmine.json",
        '{ "spec_files": ["**/*[sS]pec.js"] }\n',
        '{ "spec_files": [] }\n',
      ),
    ],
    violations: ["protectedConfigs", "protectedConfigs"],
  },
  {
    name: 'r2: package.json "size-limit"',
    idea: "The size-limit CI check's budget lives in package.json.",
    changes: [
      edit(
        "package.json",
        `${JSON.stringify({ name: "shop", "size-limit": [{ path: "dist/index.js", limit: "10 kB" }] }, null, 2)}\n`,
        `${JSON.stringify({ name: "shop", "size-limit": [{ path: "dist/index.js", limit: "100 kB" }] }, null, 2)}\n`,
      ),
    ],
    violations: ["protectedConfigs"],
  },
  // ================================================================== round 3 (after 1535309)
  {
    name: "r3: .swcrc, sonar-project.properties, commitlint config",
    idea: "SWC transforms test code like Babel (@swc/jest); Sonar's quality gate and commitlint are CI checks.",
    changes: [
      edit(
        ".swcrc",
        '{ "jsc": {} }\n',
        '{ "jsc": { "experimental": { "plugins": [["./strip-expect.wasm", {}]] } } }\n',
      ),
      edit(
        "sonar-project.properties",
        "sonar.qualitygate.wait=true\n",
        "sonar.qualitygate.wait=false\n",
      ),
      edit(
        "commitlint.config.js",
        'export default { extends: ["@commitlint/config-conventional"] };\n',
        "export default {};\n",
      ),
    ],
    violations: ["protectedConfigs", "protectedConfigs", "protectedConfigs"],
  },
];
