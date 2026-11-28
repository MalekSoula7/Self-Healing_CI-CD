// Needs Postgres. Better Auth reads and writes its tables through Prisma: every field it expects
// must exist in our migrated database, with a compatible type, and be nullable where Better Auth
// may leave it empty. Catches drift when Better Auth is upgraded or its options change.
import { createLogger } from "@pipeheal/shared/logger";
import { createTestDb } from "@pipeheal/db/testing";
import { getAuthTables } from "better-auth/db";
import { afterAll, describe, expect, it } from "vitest";
import { createAuthOptions } from "./options";

const db = createTestDb();

afterAll(async () => {
  await db.$disconnect();
});

const options = createAuthOptions({
  baseURL: "http://localhost:3000",
  secret: "test-secret-with-at-least-32-characters!",
  github: { clientId: "id", clientSecret: "secret" },
  database: undefined,
  logger: createLogger({ level: "silent", service: "test" }),
});

const POSTGRES_TYPES: Record<string, string[]> = {
  string: ["text"],
  boolean: ["boolean"],
  date: ["timestamp without time zone", "timestamp with time zone"],
  number: ["integer", "bigint", "double precision"],
};

interface Column {
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
}

// Prisma's adapter uses the model name as the client delegate: "user" → model User → table "User".
function tableOf(modelName: string): string {
  return `${modelName.charAt(0).toUpperCase()}${modelName.slice(1)}`;
}

describe("Better Auth tables", () => {
  const tables = Object.values(getAuthTables(options));

  it("cover user, session, account and verification", () => {
    expect(tables.map((table) => table.modelName).sort()).toEqual([
      "account",
      "session",
      "user",
      "verification",
    ]);
  });

  it.each(tables.map((table) => [table.modelName, table] as const))(
    "%s: every field exists with a compatible type and nullability",
    async (modelName, table) => {
      const columns = await db.$queryRaw<Column[]>`
        SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${tableOf(modelName)}`;
      const byName = new Map(columns.map((column) => [column.column_name, column]));

      const problems = Object.entries(table.fields).flatMap(([key, field]) => {
        const name = field.fieldName ?? key;
        const column = byName.get(name);
        if (column === undefined) return [`${name} is missing`];
        const types = POSTGRES_TYPES[String(field.type)] ?? [];
        return [
          ...(types.includes(column.data_type) ? [] : [`${name} is ${column.data_type}`]),
          ...(field.required === false && column.is_nullable === "NO"
            ? [`${name} is NOT NULL`]
            : []),
        ];
      });

      expect(byName.has("id")).toBe(true);
      expect(problems).toEqual([]);
    },
  );
});
