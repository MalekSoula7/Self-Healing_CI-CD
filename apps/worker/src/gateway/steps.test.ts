// The file tree a runner sends at step 1 reaches the model later (SPEC §7.1): it is bounded and
// redacted before it is stored (P4.3 security review M7).
import { describe, expect, it } from "vitest";
import { MAX_TREE_CHARS, MAX_TREE_ENTRIES, boundedPaths } from "./steps";

describe("boundedPaths", () => {
  it("keeps paths as they are when they're plain", () => {
    expect(boundedPaths(["src/a.ts", "README.md"])).toEqual(["src/a.ts", "README.md"]);
    expect(boundedPaths([])).toEqual([]);
  });

  it("keeps at most MAX_TREE_ENTRIES paths and MAX_TREE_CHARS characters", () => {
    const many = Array.from({ length: MAX_TREE_ENTRIES + 50 }, (_, i) => `f${String(i)}.ts`);
    const long = Array.from({ length: 100 }, (_, i) => `${"d".repeat(4_000)}/${String(i)}`);

    expect(boundedPaths(many)).toHaveLength(MAX_TREE_ENTRIES);
    expect(boundedPaths(long).join("\n").length).toBeLessThanOrEqual(MAX_TREE_CHARS);
  });

  it("redacts secrets in file names", () => {
    const token = `ghp_${"Z9y8X7w6V5".repeat(4)}`;

    const paths = boundedPaths([`notes/${token}.txt`, "src/a.ts"]);

    expect(paths.join("\n")).not.toContain(token);
    expect(paths).toContain("src/a.ts");
  });
});
