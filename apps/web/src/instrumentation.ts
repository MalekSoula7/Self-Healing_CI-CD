import { webEnv } from "./env";

// Runs once when the server starts: fail fast on invalid configuration.
export function register(): void {
  if (process.env.NEXT_RUNTIME === "nodejs") webEnv();
}
