// Test-only helpers for @pipeheal/db. Never imported by runtime code (enforced by ESLint).
import { inject } from "vitest";
import { createDb, type Db } from "../client";

export { TEST_DATABASE, resetTestDatabase, runPrisma, testDatabaseUrl } from "./database";

declare module "vitest" {
  export interface ProvidedContext {
    /** URL of the freshly migrated test database (vitest.integration.globalSetup.ts). */
    databaseUrl: string;
  }
}

/** A client on the test database. Integration tests only; call `$disconnect()` in afterAll. */
export function createTestDb(): Db {
  return createDb(inject("databaseUrl"));
}
