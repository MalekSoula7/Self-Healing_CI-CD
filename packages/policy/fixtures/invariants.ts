// INV-GITHUB-DIR, INV-PATH, INV-SECRETS, INV-FILE-TYPES, INV-TEST-DELETE (SPEC §8.2).
import { absent, add, edit, remove, rename, text, type FixtureFamily } from "./types";

export const invariants: FixtureFamily = {
  allowed: [
    { name: "a source edit", changes: [edit("src/a.ts", "a\n", "b\n")], violations: [] },
    {
      name: "names that only look like protected ones",
      changes: [
        edit("docs/.github-notes.md", "a\n", "b\n"),
        edit("src/env.ts", "a\n", "b\n"),
        edit("src/keys.ts", "a\n", "b\n"),
      ],
      violations: [],
    },
    {
      name: "a test file renamed to another test file (may_edit_tests)",
      policy: { tests: { mode: "may_edit_tests" } },
      changes: [rename("src/a.test.ts", "src/b.test.ts", "it('x', () => {});\n")],
      violations: [],
    },
    {
      name: "an executable script edited without changing its mode",
      changes: [{ path: "bin/run.sh", old: text("a\n", "100755"), new: text("b\n", "100755") }],
      violations: [],
    },
  ],
  forbidden: [
    {
      name: "a workflow edit",
      changes: [edit(".github/workflows/ci.yml", "a\n", "b\n")],
      violations: ["INV-GITHUB-DIR"],
    },
    {
      name: "a workflow edit under another case",
      changes: [edit(".GitHub/workflows/ci.yml", "a\n", "b\n")],
      violations: ["INV-GITHUB-DIR"],
    },
    {
      name: ".github's Windows short name",
      changes: [add("GITHUB~1/workflows/ci.yml", "on: push\n")],
      violations: ["INV-GITHUB-DIR"],
    },
    {
      name: "a file renamed out of .github",
      changes: [rename(".github/CODEOWNERS", "CODEOWNERS", "* @me\n")],
      violations: ["INV-GITHUB-DIR"],
    },
    {
      name: "a nested .git directory",
      changes: [add("vendor/lib/.git/hooks/post-checkout", "#!/bin/sh\n")],
      violations: ["INV-PATH"],
    },
    {
      name: "a .gitmodules edit",
      changes: [edit(".gitmodules", "a\n", "b\n")],
      violations: ["INV-PATH"],
    },
    {
      name: "a name Windows reserves",
      changes: [add("src/aux.ts", "export {};\n")],
      violations: ["INV-PATH"],
    },
    {
      name: "an .env edit",
      changes: [edit(".env", "A=1\n", "A=2\n")],
      violations: ["INV-SECRETS"],
    },
    {
      name: "a nested .env.local, deleted",
      changes: [remove("apps/web/.env.local", "A=1\n")],
      violations: ["INV-SECRETS"],
    },
    {
      name: "a key under another case",
      changes: [add("certs/Server.PEM", "-----BEGIN-----\n")],
      violations: ["INV-SECRETS"],
    },
    {
      name: "a secrets directory",
      changes: [add("config/secrets/token.txt", "x\n")],
      violations: ["INV-SECRETS"],
    },
    {
      name: "a binary file",
      changes: [{ path: "assets/logo.png", old: absent, new: { kind: "binary", mode: "100644" } }],
      violations: ["INV-FILE-TYPES"],
    },
    {
      name: "a symlink",
      changes: [{ path: "src/link.ts", old: absent, new: { kind: "symlink" } }],
      violations: ["INV-FILE-TYPES"],
    },
    {
      name: "a file replaced by a symlink",
      changes: [{ path: "src/a.ts", old: text("a\n"), new: { kind: "symlink" } }],
      violations: ["INV-FILE-TYPES"],
    },
    {
      name: "a submodule bump",
      changes: [{ path: "vendor/lib", old: { kind: "submodule" }, new: { kind: "submodule" } }],
      violations: ["INV-FILE-TYPES"],
    },
    {
      name: "a mode change",
      changes: [{ path: "bin/run.sh", old: text("a\n"), new: text("a\n", "100755") }],
      violations: ["INV-FILE-TYPES"],
    },
    {
      name: "a deleted test file (even when tests may be edited)",
      policy: { tests: { mode: "may_edit_tests" } },
      changes: [remove("src/a.test.ts", "it('x', () => {});\n")],
      violations: ["INV-TEST-DELETE"],
    },
    {
      name: "a test file renamed away",
      policy: { tests: { mode: "may_edit_tests" } },
      changes: [rename("tests/test_api.py", "attic/api.py", "def test_x(): pass\n")],
      violations: ["INV-TEST-DELETE"],
    },
    {
      name: "a deleted snapshot",
      policy: { tests: { mode: "may_edit_tests" } },
      changes: [remove("src/__snapshots__/a.test.ts.snap", "exports[`x`] = `1`;\n")],
      violations: ["INV-TEST-DELETE"],
    },
  ],
};
