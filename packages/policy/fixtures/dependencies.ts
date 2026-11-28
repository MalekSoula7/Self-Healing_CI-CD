// dependencies.mode and dependencies.allowNew (SPEC §8.5): manifests compared old against new,
// lockfiles only with an allowed manifest change. The default is frozen, no new packages.
import type { PolicyLayer } from "../src/index";
import { add, edit, remove, type FixtureFamily } from "./types";

const pkg = (dependencies: Record<string, string>, devDependencies: Record<string, string> = {}) =>
  `${JSON.stringify({ name: "shop", version: "1.0.0", dependencies, devDependencies }, null, 2)}\n`;

const mode = (value: "patch" | "minor" | "any", allowNew = false): PolicyLayer => ({
  dependencies: { mode: value, allowNew },
});

const LOCK = "lockfileVersion: '9.0'\n";

export const dependencies: FixtureFamily = {
  allowed: [
    {
      name: "package.json changed outside its dependencies (frozen)",
      changes: [
        edit(
          "package.json",
          pkg({ zod: "^4.1.0" }),
          pkg({ zod: "^4.1.0" }).replace('"version": "1.0.0"', '"version": "1.0.1"'),
        ),
      ],
      violations: [],
    },
    {
      name: "a patch bump with its lockfile (patch)",
      policy: mode("patch"),
      changes: [
        edit("package.json", pkg({ zod: "^4.1.0" }), pkg({ zod: "^4.1.2" })),
        edit("pnpm-lock.yaml", LOCK, `${LOCK}# zod 4.1.2\n`),
      ],
      violations: [],
    },
    {
      name: "a minor bump (minor)",
      policy: mode("minor"),
      changes: [edit("package.json", pkg({}, { vitest: "^5.0.0" }), pkg({}, { vitest: "^5.1.0" }))],
      violations: [],
    },
    {
      name: "a major bump and a lockfile alone (any)",
      policy: mode("any"),
      changes: [
        edit("package.json", pkg({ zod: "^3.0.0" }), pkg({ zod: "^4.0.0" })),
        edit("apps/web/yarn.lock", "# v1\n", "# v2\n"),
      ],
      violations: [],
    },
    {
      name: "a new package where allowed",
      policy: mode("patch", true),
      changes: [
        edit("package.json", pkg({ zod: "^4.1.0" }), pkg({ zod: "^4.1.0", "is-odd": "3.0.1" })),
      ],
      violations: [],
    },
    {
      name: "a pinned Python patch (patch)",
      policy: mode("patch"),
      changes: [edit("requirements.txt", "flask==3.0.0\n", "# web\nflask==3.0.3\n")],
      violations: [],
    },
    {
      name: "a Poetry minor (minor)",
      policy: mode("minor"),
      changes: [
        edit(
          "pyproject.toml",
          '[tool.poetry.dependencies]\npython = "^3.12"\nfastapi = "^1.2"\n',
          '[tool.poetry.dependencies]\npython = "^3.12"\nfastapi = "^1.3"\n',
        ),
      ],
      violations: [],
    },
  ],
  forbidden: [
    {
      name: "any bump while frozen (the default)",
      changes: [edit("package.json", pkg({ zod: "^4.1.0" }), pkg({ zod: "^4.1.1" }))],
      violations: ["dependencies.mode"],
    },
    {
      name: "a minor bump (patch)",
      policy: mode("patch"),
      changes: [edit("package.json", pkg({ zod: "^4.1.0" }), pkg({ zod: "^4.2.0" }))],
      violations: ["dependencies.mode"],
    },
    {
      name: "a major bump (minor)",
      policy: mode("minor"),
      changes: [edit("package.json", pkg({ zod: "^3.24.0" }), pkg({ zod: "^4.0.0" }))],
      violations: ["dependencies.mode"],
    },
    {
      name: "a 0.x minor bump, which breaks (minor)",
      policy: mode("minor"),
      changes: [edit("package.json", pkg({ tiny: "^0.2.0" }), pkg({ tiny: "^0.3.0" }))],
      violations: ["dependencies.mode"],
    },
    {
      name: "a pin widened to a caret range (patch)",
      policy: mode("patch"),
      changes: [edit("package.json", pkg({ zod: "4.1.0" }), pkg({ zod: "^4.1.0" }))],
      violations: ["dependencies.mode"],
    },
    {
      name: "a downgrade (minor)",
      policy: mode("minor"),
      changes: [edit("package.json", pkg({ zod: "^4.1.0" }), pkg({ zod: "^4.0.0" }))],
      violations: ["dependencies.mode"],
    },
    {
      name: "a dependency swapped for a git URL (minor)",
      policy: mode("minor"),
      changes: [edit("package.json", pkg({ zod: "^4.1.0" }), pkg({ zod: "github:someone/zod" }))],
      violations: ["dependencies.allowNew", "dependencies.mode"],
    },
    {
      name: "a new package (patch, no new packages)",
      policy: mode("patch"),
      changes: [edit("package.json", pkg({}), pkg({ "left-pad": "1.3.0" }))],
      violations: ["dependencies.allowNew"],
    },
    {
      name: "a package removed (minor)",
      policy: mode("minor"),
      changes: [edit("package.json", pkg({}, { "eslint-plugin-x": "^1.0.0" }), pkg({}))],
      violations: ["dependencies.mode"],
    },
    {
      name: "an override added (minor)",
      policy: mode("minor"),
      changes: [
        edit(
          "package.json",
          pkg({ zod: "^4.1.0" }),
          pkg({ zod: "^4.1.0" }).replace(
            '"version": "1.0.0",',
            '"version": "1.0.0",\n  "overrides": { "zod": "3.0.0" },',
          ),
        ),
      ],
      violations: ["dependencies.mode"],
    },
    {
      name: "a lockfile alone (frozen)",
      changes: [edit("package-lock.json", "{}\n", '{ "lockfileVersion": 3 }\n')],
      violations: ["dependencies.mode"],
    },
    {
      name: "a lockfile alone (patch): no manifest change allows it",
      policy: mode("patch"),
      changes: [edit("poetry.lock", "# a\n", "# b\n")],
      violations: ["dependencies.mode"],
    },
    {
      name: "a lockfile with a refused manifest change (patch)",
      policy: mode("patch"),
      changes: [
        edit("package.json", pkg({ zod: "^4.1.0" }), pkg({ zod: "^5.0.0" })),
        edit("pnpm-lock.yaml", LOCK, `${LOCK}# zod 5\n`),
      ],
      violations: ["dependencies.mode", "dependencies.mode"],
    },
    {
      name: "a Python pin opened up (minor)",
      policy: mode("minor"),
      changes: [edit("requirements.txt", "flask==3.0.0\n", "flask>=3.0.0\n")],
      violations: ["dependencies.mode"],
    },
    {
      name: "a package index added (minor)",
      policy: mode("minor", true),
      changes: [
        edit(
          "requirements.txt",
          "flask==3.0.0\n",
          "--extra-index-url https://pkgs.example\nflask==3.0.0\n",
        ),
      ],
      violations: ["dependencies.mode"],
    },
    {
      name: "a pyproject dependency bump (frozen)",
      changes: [
        edit(
          "pyproject.toml",
          '[project]\nname = "shop"\ndependencies = ["httpx==0.27.0"]\n',
          '[project]\nname = "shop"\ndependencies = ["httpx==0.27.2"]\n',
        ),
      ],
      violations: ["dependencies.mode"],
    },
    {
      name: "a Pipfile package added (minor, no new packages)",
      policy: mode("minor"),
      changes: [
        edit(
          "Pipfile",
          '[packages]\nflask = "==3.0.0"\n',
          '[packages]\nflask = "==3.0.0"\nrequests = "*"\n',
        ),
      ],
      violations: ["dependencies.allowNew"],
    },
    {
      name: "a new manifest's packages (patch, no new packages)",
      policy: mode("patch"),
      changes: [add("packages/new/package.json", pkg({ zod: "^4.1.0" }))],
      violations: ["dependencies.allowNew"],
    },
    {
      name: "a manifest deleted (minor)",
      policy: mode("minor"),
      changes: [remove("requirements-dev.txt", "pytest==8.3.0\n")],
      violations: ["dependencies.mode"],
    },
    {
      name: "a manifest that doesn't parse",
      policy: mode("any", true),
      changes: [edit("package.json", pkg({}), "{ broken\n")],
      violations: ["dependencies.mode"],
    },
  ],
};
