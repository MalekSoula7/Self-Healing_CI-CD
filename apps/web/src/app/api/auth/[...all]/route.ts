// Better Auth's endpoints (sign-in, OAuth callback, session, sign-out).
import { getAuth } from "@/lib/auth/server";

async function handle(request: Request): Promise<Response> {
  const auth = getAuth();
  if (auth === null) return Response.json({ error: "not found" }, { status: 404 });
  return auth.handler(request);
}

export { handle as GET, handle as POST };
