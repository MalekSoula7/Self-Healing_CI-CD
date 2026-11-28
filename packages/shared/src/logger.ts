// The one logger for every service, imported as "@pipeheal/shared/logger" (a separate entry point so
// the web app's client-side imports of @pipeheal/shared never pull in pino).
// Every argument of every log call goes through the redactor first (CLAUDE.md: never log secrets).
import { pino, type DestinationStream, type Logger } from "pino";
import { redactText, redactValue } from "./redact";

export type { Logger } from "pino";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface CreateLoggerOptions {
  level: LogLevel;
  service: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

// pino applies `formatters.bindings` to the root logger only (children get an identity formatter),
// so child() is wrapped to redact bindings before pino serializes them. Children inherit the wrapper
// through the prototype chain, so grandchildren are covered too.
function redactChildBindings(logger: Logger): Logger {
  // Read without binding: `this` must stay dynamic so each child creates its own children.
  const originalChild = Reflect.get(logger, "child") as (
    this: Logger,
    ...args: unknown[]
  ) => unknown;
  Object.defineProperty(logger, "child", {
    value: function redactedChild(this: Logger, ...args: unknown[]): unknown {
      const [bindings, ...rest] = args;
      return Reflect.apply(originalChild, this, [redactValue(bindings), ...rest]);
    },
  });
  return logger;
}

export function createLogger(
  options: CreateLoggerOptions,
  destination?: DestinationStream,
): Logger {
  const logger = pino(
    {
      level: options.level,
      base: { service: options.service },
      timestamp: pino.stdTimeFunctions.isoTime,
      hooks: {
        logMethod(args, method) {
          const safe = args.map((arg: unknown) =>
            typeof arg === "string" ? redactText(arg) : redactValue(arg),
          );
          Reflect.apply(method, this, safe);
        },
      },
      formatters: {
        bindings: (bindings) => asRecord(redactValue(bindings)),
      },
      serializers: {
        err: (err: unknown) => redactValue(err),
      },
    },
    destination,
  );
  return redactChildBindings(logger);
}
