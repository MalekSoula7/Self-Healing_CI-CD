// `pnpm db:migrate [--name <name>]`: `prisma migrate dev`, then `prisma generate`.
// Since Prisma 7, `migrate dev` no longer runs generators, and a stale client would type-check
// against the old schema.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");

function prisma(args: readonly string[]): void {
  const { status } = spawnSync(process.execPath, [prismaCli, ...args], { stdio: "inherit" });
  if (status !== 0) process.exit(status ?? 1);
}

prisma(["migrate", "dev", ...process.argv.slice(2)]);
prisma(["generate"]);
