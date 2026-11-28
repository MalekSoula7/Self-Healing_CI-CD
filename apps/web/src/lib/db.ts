import "server-only";
import { createDb, type Db } from "@pipeheal/db";
import { webEnv } from "@/env";

const cache = globalThis as { pipehealDb?: Db };

/** One Prisma client (and pg pool) per server process, kept across dev hot reloads. */
export function getDb(): Db {
  cache.pipehealDb ??= createDb(webEnv().DATABASE_URL);
  return cache.pipehealDb;
}
