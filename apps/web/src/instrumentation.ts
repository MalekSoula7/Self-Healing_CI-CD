// Runs once when the server starts: fail fast on invalid configuration. Imported lazily so the
// Edge bundle of this file doesn't pull in server-only modules.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { webEnv } = await import("./env");
  webEnv();
}
