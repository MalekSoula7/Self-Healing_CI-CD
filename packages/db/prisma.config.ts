// Prisma CLI configuration (generate, migrate, studio, seed).
// DATABASE_URL comes from the environment, then the root `.env` (one .env for the whole repo,
// SPEC §4.1), then the docker compose default. Variables already set in the environment win.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "prisma/config";
import { DEV_DATABASE_URL } from "./src/url";

const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? DEV_DATABASE_URL,
  },
});
