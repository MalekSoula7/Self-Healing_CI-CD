import { pino, type DestinationStream, type Logger } from "pino";

export type LogLevel = "debug" | "info" | "warn" | "error";

// Values at these paths are replaced before anything is written (CLAUDE.md: never log secrets).
// This is a safety net, not permission: log IDs and redacted excerpts, never whole payloads.
const SECRET_FIELDS = [
  "token",
  "accessToken",
  "refreshToken",
  "sessionToken",
  "apiKey",
  "secret",
  "password",
  "privateKey",
];

export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-hub-signature-256"]',
  "headers.authorization",
  "headers.cookie",
  ...SECRET_FIELDS,
  ...SECRET_FIELDS.map((field) => `*.${field}`),
];

export function createLogger(
  options: { level: LogLevel; service: string },
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      level: options.level,
      base: { service: options.service },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    },
    destination,
  );
}
