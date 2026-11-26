// `.pipeheal.yml` (SPEC §8.1, P3.7): read, validated, errors kept for the UI, never thrown.
// Written before the implementation.
import { describe, expect, it } from "vitest";
import { MAX_POLICY_FILE_BYTES, readPolicyFile } from "./policy-file";

describe("readPolicyFile", () => {
  it("reads a valid file into a layer", () => {
    const read = readPolicyFile(
      [
        "# PipeHeal rules for this repo",
        "paths:",
        "  deny: [src/legacy/**]",
        "limits:",
        "  maxFilesChanged: 3",
        "tests:",
        "  mode: source_only",
      ].join("\n"),
    );

    expect(read).toEqual({
      layer: {
        paths: { deny: ["src/legacy/**"] },
        limits: { maxFilesChanged: 3 },
        tests: { mode: "source_only" },
      },
      errors: null,
    });
  });

  it("treats an empty file as an empty layer", () => {
    expect(readPolicyFile("")).toEqual({ layer: {}, errors: null });
    expect(readPolicyFile("# nothing yet\n")).toEqual({ layer: {}, errors: null });
  });

  it("names each schema problem by its field", () => {
    const read = readPolicyFile(
      "limits:\n  maxFilesChanged: 500\ntests:\n  mode: anything\nunknownKey: 1\n",
    );

    expect(read.layer).toBeNull();
    expect(read.errors).toHaveLength(3);
    expect(read.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^limits\.maxFilesChanged: /),
        expect.stringMatching(/^tests\.mode: /),
        expect.stringMatching(/unknownKey/),
      ]),
    );
  });

  it.each([
    ["broken YAML", "paths: [unclosed\n"],
    ["a list at the top", "- a\n- b\n"],
    ["a scalar at the top", "just text\n"],
    ["duplicate keys", "limits: {}\nlimits: {}\n"],
    ["a custom tag", "paths: !!js/function 'x'\n"],
    [
      "an alias bomb",
      `a: &a [x, x, x, x, x, x, x, x, x, x]\n${Array.from({ length: 9 }, (_, i) => `l${String(i)}: &l${String(i)} [${Array.from({ length: 10 }, () => (i === 0 ? "*a" : `*l${String(i - 1)}`)).join(", ")}]`).join("\n")}\n`,
    ],
  ])("reports %s as an error, never throws", (_, text) => {
    const read = readPolicyFile(text);

    expect(read.layer).toBeNull();
    expect(read.errors?.length).toBeGreaterThan(0);
    for (const error of read.errors ?? []) expect(error.length).toBeLessThanOrEqual(300);
  });

  it("refuses a file over the size limit", () => {
    const read = readPolicyFile(`# ${"x".repeat(MAX_POLICY_FILE_BYTES)}\n`);

    expect(read).toEqual({ layer: null, errors: [expect.stringContaining("too large")] });
  });

  it("keeps at most 20 errors", () => {
    const deny = Array.from({ length: 40 }, (_, i) => `  - /abs${String(i)}`).join("\n");

    expect(readPolicyFile(`paths:\n  deny:\n${deny}\n`).errors).toHaveLength(20);
  });
});
