import { describe, expect, it } from "vitest";
import { dryRun, effectiveRows, layerLabel } from "./policy";

describe("effectiveRows", () => {
  it("shows each field's effective value and the layers it comes from", () => {
    const rows = effectiveRows({
      orgDefaults: { limits: { maxFilesChanged: 8 } },
      repoFile: { limits: { maxFilesChanged: 3 }, paths: { allow: ["src/**"] } },
      orgGuardrails: { scope: { branches: { include: ["main"] } } },
    });
    const row = (field: string) => rows.find((each) => each.field === field);

    expect(row("limits.maxFilesChanged")).toEqual({
      field: "limits.maxFilesChanged",
      value: "3",
      sources: ["repo-file"],
    });
    // Lists accumulate their sources: the system's (empty) list and the file's.
    expect(row("paths.allow")).toMatchObject({
      value: '[["src/**"]]',
      sources: ["system", "repo-file"],
    });
    expect(row("scope.branches.include")).toMatchObject({
      value: '[["**"],["main"]]',
      sources: ["system", "org-guardrail"],
    });
    expect(row("tests.mode")).toEqual({
      field: "tests.mode",
      value: '"source_only"',
      sources: ["system"],
    });
  });

  it("shortens long values and names empty lists", () => {
    const deny = Array.from({ length: 40 }, (_, index) => `generated/${String(index)}/**`);
    const rows = effectiveRows({ orgDefaults: { paths: { deny } } });

    expect(rows.find((row) => row.field === "paths.deny")?.value).toMatch(/\.\.\.$/);
    expect(rows.find((row) => row.field === "paths.allow")?.value).toBe("none");
  });
});

describe("layerLabel", () => {
  it.each([
    ["system", "PipeHeal default"],
    ["repo-file", ".pipeheal.yml"],
    ["org-guardrail", "org guardrail"],
    ["custom:repo:CR-1", "custom rule CR-1"],
  ] as const)("%s reads as %s", (name, label) => {
    expect(layerLabel(name)).toBe(label);
  });
});

describe("dryRun", () => {
  const diff = [
    "diff --git a/infra/main.tf b/infra/main.tf",
    "--- a/infra/main.tf",
    "+++ b/infra/main.tf",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "",
  ].join("\n");

  it("lists what the checks would refuse under the layers", () => {
    expect(dryRun({}, diff)).toEqual({
      status: "done",
      files: 1,
      violations: [
        {
          ruleId: "paths.deny",
          path: "infra/main.tf",
          line: null,
          message: "infra/main.tf matches the denied path infra/**.",
        },
      ],
      drafts: [],
    });
    expect(dryRun({ repo: { paths: { deny: [] } } }, diff)).toMatchObject({ violations: [] });
  });

  it("explains a diff it can't read", () => {
    expect(dryRun({}, "hello")).toEqual({
      status: "invalid",
      error: "no `diff --git` sections found",
    });
  });
});
