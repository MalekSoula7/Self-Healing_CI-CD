// The committed bundles are what workflows and local mode run (D19, P4.6): they must be the build
// of the current sources. Rebuild with `pnpm --filter @pipeheal/heal-action bundle` when this fails.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ENTRIES, bundleAction } from "./bundle";

describe("dist/", () => {
  it.each(Object.keys(ENTRIES) as (keyof typeof ENTRIES)[])(
    "%s is the bundle of the current sources",
    async (entry) => {
      const committed = await readFile(new URL(`../dist/${entry}`, import.meta.url), "utf8");

      expect(committed === (await bundleAction(entry))).toBe(true);
    },
    60_000,
  );
});
