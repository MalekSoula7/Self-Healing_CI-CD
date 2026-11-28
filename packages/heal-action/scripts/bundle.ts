// Bundles the action into dist/, committed so a workflow can use it straight from the repository
// (D19): index.mjs for GitHub, local.mjs for local mode (P4.6).
// `pnpm --filter @pipeheal/heal-action bundle`; a test fails when either is stale.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ENTRIES, bundleAction } from "../src/bundle";

for (const entry of Object.keys(ENTRIES) as (keyof typeof ENTRIES)[]) {
  const out = fileURLToPath(new URL(`../dist/${entry}`, import.meta.url));
  await writeFile(out, await bundleAction(entry));
  process.stdout.write(`wrote ${out}\n`);
}
