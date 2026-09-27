// `pnpm db:seed` (run by `prisma db seed`): demo data for a local development database only.
import { createLogger } from "@pipeheal/shared/logger";
import { createDb } from "../src/client";
import { SEED_ORG_SLUG, assertSeedable, seed } from "../src/seed";
import { DEV_DATABASE_URL } from "../src/url";

const logger = createLogger({ level: "info", service: "db-seed" });
const databaseUrl = process.env.DATABASE_URL ?? DEV_DATABASE_URL;
assertSeedable(databaseUrl, process.env.NODE_ENV);

const db = createDb(databaseUrl);
try {
  await seed(db);
  logger.info({ org: SEED_ORG_SLUG }, "seeded demo data");
} finally {
  await db.$disconnect();
}
