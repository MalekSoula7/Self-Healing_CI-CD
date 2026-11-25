// protectedConfigs (SPEC §8.5): test, lint, format and type-check configuration, wholesale or by
// section (package.json and pyproject.toml; their dependency sections are dependencies.*'s).
import { add, edit, remove, type FixtureFamily } from "./types";

const PACKAGE = (extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ name: "shop", version: "1.0.0", scripts: { test: "vitest run" }, ...extra }, null, 2)}\n`;

const PYPROJECT = (pytest: string, description = "Shop") => `[project]
name = "shop"
description = "${description}"
dependencies = ["httpx==0.27.0"]

[tool.pytest.ini_options]
addopts = "${pytest}"

[tool.poetry.dependencies]
python = "^3.12"
`;

export const configs: FixtureFamily = {
  allowed: [
    {
      name: "a source file named like a config",
      changes: [edit("src/eslint-rules.ts", "a\n", "b\n")],
      violations: [],
    },
    {
      name: "package.json fields that configure no check",
      changes: [edit("package.json", PACKAGE(), PACKAGE({ version: "1.0.1", type: "module" }))],
      violations: [],
    },
    {
      name: "pyproject.toml outside [tool.*]",
      changes: [edit("pyproject.toml", PYPROJECT("-q"), PYPROJECT("-q", "A shop"))],
      violations: [],
    },
    {
      name: "configs when the policy doesn't protect them",
      policy: { protectedConfigs: false },
      changes: [edit("tsconfig.json", "{}\n", '{ "compilerOptions": { "strict": false } }\n')],
      violations: [],
    },
  ],
  forbidden: [
    {
      name: "tsconfig strictness",
      changes: [edit("tsconfig.json", "{}\n", '{ "compilerOptions": { "strict": false } }\n')],
      violations: ["protectedConfigs"],
    },
    {
      name: "a nested tsconfig variant",
      changes: [edit("packages/a/tsconfig.build.json", "{}\n", "{ }\n")],
      violations: ["protectedConfigs"],
    },
    {
      name: "vitest and playwright configs",
      changes: [
        edit("vitest.config.ts", "export default {};\n", "export default { test: { bail: 0 } };\n"),
        edit("apps/web/playwright.config.ts", "a\n", "b\n"),
      ],
      violations: ["protectedConfigs", "protectedConfigs"],
    },
    {
      name: "eslint flat config, legacy config and ignore file",
      changes: [
        edit("eslint.config.mjs", "export default [];\n", "export default [{ rules: {} }];\n"),
        edit("packages/x/.eslintrc.json", "{}\n", '{ "root": true }\n'),
        add(".eslintignore", "src/broken.ts\n"),
      ],
      violations: ["protectedConfigs", "protectedConfigs", "protectedConfigs"],
    },
    {
      name: "a prettier config deleted",
      changes: [remove(".prettierrc", "{}\n")],
      violations: ["protectedConfigs"],
    },
    {
      name: "Python tool configs",
      changes: [
        edit("pytest.ini", "[pytest]\n", "[pytest]\naddopts = -k 'not slow'\n"),
        edit("setup.cfg", "[flake8]\n", "[flake8]\nignore = E501\n"),
        add("ruff.toml", "ignore = ['F401']\n"),
        edit(".coveragerc", "[run]\n", "[run]\nomit = src/*\n"),
      ],
      // setup.cfg also declares dependencies (install_requires).
      violations: [
        "protectedConfigs",
        "protectedConfigs",
        "dependencies.mode",
        "protectedConfigs",
        "protectedConfigs",
      ],
    },
    {
      name: "a package.json test script",
      changes: [edit("package.json", PACKAGE(), PACKAGE({ scripts: { test: "exit 0" } }))],
      violations: ["protectedConfigs"],
    },
    {
      name: "a package.json jest section added",
      changes: [
        edit("package.json", PACKAGE(), PACKAGE({ jest: { testPathIgnorePatterns: ["cart"] } })),
      ],
      violations: ["protectedConfigs"],
    },
    {
      name: "pyproject.toml's [tool.pytest] options",
      changes: [edit("pyproject.toml", PYPROJECT("-q"), PYPROJECT("-q -k 'not cart'"))],
      violations: ["protectedConfigs"],
    },
    {
      // A line-based reader would put `filterwarnings` under [project]: the file is parsed instead.
      name: "a [tool.pytest] key after a header hidden in a string",
      changes: [
        edit(
          "pyproject.toml",
          PYPROJECT("-q"),
          PYPROJECT("-q").replace(
            'addopts = "-q"\n',
            'addopts = "-q"\nnote = """\n[project]\n"""\nfilterwarnings = ["ignore"]\n',
          ),
        ),
      ],
      violations: ["protectedConfigs"],
    },
  ],
};
