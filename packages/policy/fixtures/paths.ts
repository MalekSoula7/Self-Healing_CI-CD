// paths.deny and paths.allow (SPEC §8.5): on both the old and the new path of a change.
import { add, edit, remove, rename, type FixtureFamily } from "./types";

export const paths: FixtureFamily = {
  allowed: [
    {
      name: "a path no glob denies",
      changes: [edit("src/infra.ts", "a\n", "b\n")],
      violations: [],
    },
    {
      name: "inside every allow list",
      policy: { paths: { allow: ["src/**", "lib/**"] } },
      changes: [edit("src/a.ts", "a\n", "b\n"), add("lib/b.ts", "export {};\n")],
      violations: [],
    },
    {
      name: "a rename within the allowed paths",
      policy: { paths: { allow: ["src/**"] } },
      changes: [rename("src/a.ts", "src/b.ts", "export {};\n")],
      violations: [],
    },
  ],
  forbidden: [
    {
      name: "a denied directory (system default)",
      changes: [edit("infra/main.tf", "a\n", "b\n")],
      violations: ["paths.deny"],
    },
    {
      name: "a denied directory under another case",
      changes: [edit("Infra/main.tf", "a\n", "b\n")],
      violations: ["paths.deny"],
    },
    {
      name: "a migration at any depth",
      changes: [add("apps/api/db/migrations/0002_x.sql", "select 1;\n")],
      violations: ["paths.deny"],
    },
    {
      name: "a Dockerfile variant",
      changes: [edit("services/api/Dockerfile.prod", "FROM a\n", "FROM b\n")],
      violations: ["paths.deny"],
    },
    {
      name: "a file renamed out of a denied directory",
      changes: [rename("terraform/vars.tf", "src/vars.tf", "x\n")],
      violations: ["paths.deny"],
    },
    {
      name: "a file deleted from a denied directory",
      changes: [remove("infra/old.tf", "x\n")],
      violations: ["paths.deny"],
    },
    {
      name: "a repo's own deny glob",
      policy: { paths: { deny: ["src/legacy/**"] } },
      changes: [edit("src/legacy/a.ts", "a\n", "b\n")],
      violations: ["paths.deny"],
    },
    {
      name: "outside the allow list",
      policy: { paths: { allow: ["src/**"] } },
      changes: [edit("lib/a.ts", "a\n", "b\n")],
      violations: ["paths.allow"],
    },
    {
      name: "an allow list matches as written, never case-insensitively",
      policy: { paths: { allow: ["src/**"] } },
      changes: [add("SRC/a.ts", "export {};\n")],
      violations: ["paths.allow"],
    },
    {
      name: "renamed out of the allowed paths",
      policy: { paths: { allow: ["src/**"] } },
      changes: [rename("src/a.ts", "lib/a.ts", "export {};\n")],
      violations: ["paths.allow"],
    },
  ],
};
