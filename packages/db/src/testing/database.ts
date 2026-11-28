// Test database lifecycle for integration tests (vitest.integration.globalSetup.ts).
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isLoopbackUrl, redactText } from "@pipeheal/shared";
import { createDb } from "../client";

export const TEST_DATABASE = "pipeheal_test";

const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");
const packageDir = fileURLToPath(new URL("../..", import.meta.url));

function withDatabase(serverUrl: string, database: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * The test database on the same server as `serverUrl`. Only local servers are accepted, because
 * the test setup drops and recreates this database.
 */
export function testDatabaseUrl(serverUrl: string): string {
  if (!isLoopbackUrl(serverUrl)) {
    throw new Error(
      `Refusing to run database tests against a non-local server (${new URL(serverUrl).host}).`,
    );
  }
  return withDatabase(serverUrl, TEST_DATABASE);
}

export interface PrismaCliResult {
  status: number;
  /** stdout and stderr, redacted. */
  output: string;
}

/** Runs the Prisma CLI of packages/db against `databaseUrl`, with telemetry off. */
export function runPrisma(args: readonly string[], databaseUrl: string): PrismaCliResult {
  const result = spawnSync(process.execPath, [prismaCli, ...args], {
    cwd: packageDir,
    env: { ...process.env, DATABASE_URL: databaseUrl, CHECKPOINT_DISABLE: "1" },
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    output: redactText(`${result.stdout}${result.stderr}`),
  };
}

/** Drops and recreates the test database, then applies every migration. Returns its URL. */
export async function resetTestDatabase(serverUrl: string): Promise<string> {
  const url = testDatabaseUrl(serverUrl);
  const admin = createDb(withDatabase(serverUrl, "postgres"));
  try {
    // Constant statements: database names cannot be bound as query parameters.
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${TEST_DATABASE}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${TEST_DATABASE}"`);
  } catch (error) {
    // Host only: the URL carries the password.
    throw new Error(
      `Postgres not usable at ${new URL(serverUrl).host}. Run \`docker compose up -d\`.`,
      { cause: error },
    );
  } finally {
    await admin.$disconnect();
  }

  const deploy = runPrisma(["migrate", "deploy"], url);
  if (deploy.status !== 0) {
    throw new Error(`prisma migrate deploy failed on the test database:\n${deploy.output}`);
  }
  return url;
}
