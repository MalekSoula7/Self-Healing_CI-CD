// Runs once before the integration project:
// - resolves the local docker compose service URLs: shell env, then the root .env (custom ports,
//   README), then the defaults. Only these two keys are read from .env, so its secrets never
//   reach tests;
// - recreates the `pipeheal_test` database and applies every migration.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { DEV_DATABASE_URL } from "@pipeheal/db";
import { resetTestDatabase } from "@pipeheal/db/testing";
import type { TestProject } from "vitest/node";

const envFile = fileURLToPath(new URL("./.env", import.meta.url));
const dotEnv = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};

function localServiceUrl(name: "DATABASE_URL" | "REDIS_URL", fallback: string): string {
  for (const value of [process.env[name], dotEnv[name]]) {
    if (value !== undefined && value !== "") return value;
  }
  return fallback;
}

export default async function setup(project: TestProject): Promise<void> {
  project.provide("redisUrl", localServiceUrl("REDIS_URL", "redis://localhost:6379"));
  const serverUrl = localServiceUrl("DATABASE_URL", DEV_DATABASE_URL);
  project.provide("databaseUrl", await resetTestDatabase(serverUrl));
}
