// Path attacks: .github/ and secrets/deny paths spelled so the globs miss them, renames across
// them, symlinks, and CI definitions that live outside .github/.
import type { ChangeInput } from "../../src/index";
import { absent, add, edit, rename, text } from "../types";
import type { Attack } from "./types";

const WORKFLOW = "on: push\njobs: {}\n";

const workflowAt = (path: string): ChangeInput => add(path, WORKFLOW);

export const pathAttacks: Attack[] = [
  // ------------------------------------------------------------------ .github spellings
  ...(
    [
      [".github as written", ".github/workflows/ci.yml"],
      ["./ prefix", "./.github/workflows/ci.yml"],
      ["// inside", ".github//workflows/ci.yml"],
      ["other case", ".GitHub/workflows/ci.yml"],
      ["8.3 short name", "GITHUB~1/workflows/ci.yml"],
      ["trailing dot", ".github./workflows/ci.yml"],
      ["trailing space", ".github /workflows/ci.yml"],
      ["zero-width non-joiner", ".git‌hub/workflows/ci.yml"],
      ["BOM inside", ".git﻿hub/workflows/ci.yml"],
      ["backslashes", ".github\\workflows\\ci.yml"],
      ["dot-dot through src", "src/../.github/workflows/ci.yml"],
    ] as const
  ).map(([how, path]): Attack => ({
    name: `control: .github via ${how}`,
    idea: `Write a workflow at ${JSON.stringify(path)}.`,
    changes: [workflowAt(path)],
    violations: ["INV-GITHUB-DIR"],
  })),
  {
    name: "control: rename into .github",
    idea: "src/ci.yml -> .github/workflows/ci.yml.",
    changes: [rename("src/ci.yml", ".github/workflows/ci.yml", WORKFLOW)],
    violations: ["INV-GITHUB-DIR"],
  },
  {
    name: "control: a new symlink pointing into .github",
    idea: "src/ci -> ../.github/workflows.",
    changes: [{ path: "src/ci", old: absent, new: { kind: "symlink" } }],
    violations: ["INV-FILE-TYPES"],
  },
  {
    name: ".github with a dotless i (U+0131)",
    idea: "'.gıthub' uppercases to '.GITHUB' (Windows' upcase table): the same folder on NTFS; toLowerCase keeps 'ı'.",
    changes: [workflowAt(".gıthub/workflows/ci.yml")],
    violations: ["INV-GITHUB-DIR"],
  },
  {
    name: "write through an existing symlinked directory",
    idea: "ci -> .github/workflows already exists; ci/deploy.yml is a plain added file to checkChanges.",
    changes: [workflowAt("ci/deploy.yml")],
    violations: ["server"],
  },
  {
    name: "a local composite action outside .github",
    idea: "Workflows run `uses: ./actions/setup`; its action.yml is CI code living outside .github/.",
    changes: [
      edit(
        "actions/setup/action.yml",
        "runs:\n  using: composite\n  steps:\n    - run: pnpm test\n      shell: bash\n",
        "runs:\n  using: composite\n  steps:\n    - run: 'true'\n      shell: bash\n",
      ),
    ],
    violations: ["protectedConfigs"],
  },

  // ------------------------------------------------------------------ secrets and deny spellings
  {
    name: "control: a key with a Kelvin sign",
    idea: "server.Key lowercases to server.key.",
    changes: [add("certs/server.Key", "x\n")],
    violations: ["INV-SECRETS"],
  },
  {
    name: "secrets/ with a long s (U+017F)",
    idea: "'ſecrets' uppercases to 'SECRETS' (NTFS) and case-folds to 'secrets' (APFS).",
    changes: [add("config/ſecrets/api.txt", "token\n")],
    violations: ["INV-SECRETS"],
  },
  {
    name: ".env by its 8.3 short name",
    idea: "A leading dot isn't 8.3, so Windows also names .env ENV~1; writing ENV~1 there writes .env.",
    changes: [add("config/ENV~1", "API_KEY=x\n")],
    violations: ["INV-SECRETS", "INV-PATH"],
  },
  {
    name: "terraform/ by its 8.3 short name",
    idea: "TERRAF~1 is terraform's short name on Windows; only github~N and git~N are spelled out.",
    changes: [add("TERRAF~1/main.tf", 'resource "x" "y" {}\n')],
    violations: ["paths.deny", "INV-PATH"],
  },
  {
    name: "control: denied directory renamed out",
    idea: "infra/x.ts -> src/x.ts touches infra/.",
    changes: [rename("infra/x.ts", "src/x.ts", "a\n")],
    violations: ["paths.deny"],
  },
  {
    name: "control: NFD path against an NFC deny glob",
    idea: "données/ (NFD) vs données/** (NFC).",
    policy: { paths: { deny: ["données/**"] } },
    changes: [add("données/x.csv", "1\n")],
    violations: ["paths.deny"],
  },
  {
    name: "control: an allow list matches as written",
    idea: "SRC/x.ts with allow src/** (on Linux CI SRC/ is another directory).",
    policy: { paths: { allow: ["src/**"] } },
    changes: [add("SRC/x.ts", "a\n")],
    violations: ["paths.allow"],
  },
  {
    name: "files that hold credentials but match no secret glob",
    idea: ".npmrc (auth tokens), id_rsa, credentials.json, a .pfx certificate.",
    changes: [
      edit(
        ".npmrc",
        "registry=https://registry.npmjs.org/\n",
        "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n",
      ),
      add("deploy/id_rsa", "-----BEGIN OPENSSH PRIVATE KEY-----\n"),
      add("config/credentials.json", "{}\n"),
    ],
    violations: ["INV-SECRETS", "INV-SECRETS", "INV-SECRETS"],
  },
  {
    name: "control: a path past git's length limit",
    idea: "A 5,000-character path.",
    changes: [add(`src/${"a".repeat(5000)}.ts`, "a\n")],
    violations: ["INV-PATH"],
  },
  {
    name: "control: an executable bit added",
    idea: "Mode change on a script.",
    changes: [{ path: "scripts/run.sh", old: text("echo\n"), new: text("echo\n", "100755") }],
    violations: ["INV-FILE-TYPES"],
  },
  // ================================================================== round 2 (after 3b71374)
  {
    name: "r2: a local JavaScript action's code",
    idea: "action.yml is protected, but `runs: { using: node20, main: dist/index.js }` - the code CI runs isn't.",
    changes: [
      edit(
        "actions/setup/dist/index.js",
        'require("child_process").execSync("pnpm test", { stdio: "inherit" });\n',
        "process.exitCode = 0;\n",
      ),
    ],
    violations: ["server"],
  },
  {
    name: "r2: secret files by other common names",
    idea: "Rails config/secrets.yml, Streamlit .streamlit/secrets.toml, .git-credentials, .pgpass, *.tfvars.",
    changes: [
      edit("config/secrets.yml", "production:\n  key: a\n", "production:\n  key: b\n"),
      edit(".streamlit/secrets.toml", 'token = "a"\n', 'token = "b"\n'),
      add(".git-credentials", "https://user:token@github.com\n"),
      add(".pgpass", "db:5432:shop:shop:secret\n"),
      edit("prod.tfvars", 'db_password = "a"\n', 'db_password = "b"\n'),
    ],
    violations: ["INV-SECRETS", "INV-SECRETS", "INV-SECRETS", "INV-SECRETS", "INV-SECRETS"],
  },
];
