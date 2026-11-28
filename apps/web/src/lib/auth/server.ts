import "server-only";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { githubSignInConfig, webEnv } from "@/env";
import { getDb } from "@/lib/db";
import { getLogger } from "@/lib/logger";
import { createAuthOptions } from "./options";

function createAuth() {
  const env = webEnv();
  const signIn = githubSignInConfig(env);
  if (signIn === null) return null;
  return betterAuth(
    createAuthOptions({
      baseURL: env.APP_URL,
      secret: signIn.secret,
      github: { clientId: signIn.clientId, clientSecret: signIn.clientSecret },
      database: prismaAdapter(getDb(), { provider: "postgresql" }),
      logger: getLogger().child({ component: "auth" }),
      // Lets server actions set Better Auth's cookies. Must stay the last plugin.
      plugins: [nextCookies()],
    }),
  );
}

export type Auth = NonNullable<ReturnType<typeof createAuth>>;

let auth: Auth | null | undefined;

/** The Better Auth instance, or null when GitHub sign-in isn't configured (development). */
export function getAuth(): Auth | null {
  if (auth === undefined) auth = createAuth();
  return auth;
}
