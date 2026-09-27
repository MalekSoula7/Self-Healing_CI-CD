import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";
import { databaseUrlSchema } from "./url";

export type Db = PrismaClient;

/**
 * Creates a Prisma client on a pg connection pool. Create one per process and reuse it.
 * The URL is validated here, but never echoed: it carries the database password.
 */
export function createDb(databaseUrl: string): Db {
  const parsed = databaseUrlSchema.safeParse(databaseUrl);
  if (!parsed.success) {
    throw new Error("Invalid database URL: must be a postgres:// or postgresql:// URL.");
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: parsed.data }) });
}
