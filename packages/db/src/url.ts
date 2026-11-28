import { isLoopbackUrl } from "@pipeheal/shared";
import { z } from "zod";

/** The docker compose Postgres (docker-compose.yml): the fallback in development and tests. */
export const DEV_DATABASE_URL = "postgresql://pipeheal:pipeheal@localhost:5432/pipeheal";

export const databaseUrlSchema = z.url({
  protocol: /^postgres(ql)?$/,
  error: "must be a postgres:// or postgresql:// URL",
});

const TLS_SSL_MODES = new Set(["require", "verify-ca", "verify-full"]);

/** True when the URL asks for TLS (`sslmode=require|verify-ca|verify-full`) or points at loopback. */
export function tlsUnlessLoopback(databaseUrl: string): boolean {
  const sslmode = new URL(databaseUrl).searchParams.get("sslmode");
  return (sslmode !== null && TLS_SSL_MODES.has(sslmode)) || isLoopbackUrl(databaseUrl);
}
