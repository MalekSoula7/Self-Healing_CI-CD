// Bundles the action into dist/index.mjs, committed so a workflow can use it straight from the
// repository (D19). `pnpm --filter @pipeheal/heal-action bundle`; a test fails when it's stale.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { bundleAction } from "../src/bundle";

const out = fileURLToPath(new URL("../dist/index.mjs", import.meta.url));
await writeFile(out, await bundleAction());
process.stdout.write(`wrote ${out}\n`);
