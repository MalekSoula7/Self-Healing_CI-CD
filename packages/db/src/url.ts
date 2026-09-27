import { z } from "zod";

/** The docker compose Postgres (docker-compose.yml): the fallback in development and tests. */
export const DEV_DATABASE_URL = "postgresql://pipeheal:pipeheal@localhost:5432/pipeheal";

export const databaseUrlSchema = z.url({
  protocol: /^postgres(ql)?$/,
  error: "must be a postgres:// or postgresql:// URL",
});
