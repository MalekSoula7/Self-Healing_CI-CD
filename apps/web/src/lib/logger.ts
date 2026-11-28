import "server-only";
import { createLogger, type Logger } from "@pipeheal/shared/logger";
import { webEnv } from "@/env";

let logger: Logger | undefined;

/** The web server's logger: every argument is redacted (SPEC §12). */
export function getLogger(): Logger {
  logger ??= createLogger({ level: webEnv().LOG_LEVEL, service: "web" });
  return logger;
}
