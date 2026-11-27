// The committed bundle is what workflows run (D19): it must be the build of the current sources.
// Rebuild with `pnpm --filter @pipeheal/heal-action bundle` when this fails.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { bundleAction } from "./bundle";

describe("dist/index.mjs", () => {
  it("is the bundle of the current sources", async () => {
    const committed = await readFile(new URL("../dist/index.mjs", import.meta.url), "utf8");

    expect(committed === (await bundleAction())).toBe(true);
  }, 60_000);
});
