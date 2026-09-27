// Liveness probe. Dependency checks (database, Redis) are added when the web app starts using them.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ status: "ok", service: "web" });
}
