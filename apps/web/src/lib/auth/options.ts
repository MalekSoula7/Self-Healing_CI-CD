// Better Auth configuration (SPEC §5.2), as a pure function of its inputs so tests can run the
// real OAuth flow against a mocked GitHub. The app's instance is built in ./server.ts.
import type { Logger } from "@pipeheal/shared/logger";
import type { BetterAuthOptions, BetterAuthPlugin, DBAdapterInstance } from "better-auth";
import { z } from "zod";

export const COOKIE_PREFIX = "pipeheal";

export const DISABLED_PATHS = [
  "/update-user",
  "/get-access-token",
  "/refresh-token",
  "/account-info",
  "/link-social",
  "/unlink-account",
] as const;

export interface AuthConfig {
  /** Public base URL of the web app (APP_URL). */
  baseURL: string;
  /** BETTER_AUTH_SECRET: signs cookies and encrypts stored OAuth tokens. */
  secret: string;
  /** The GitHub App's OAuth client credentials. */
  github: { clientId: string; clientSecret: string };
  /** A Better Auth adapter (Prisma in the app, in-memory in unit tests). */
  database: DBAdapterInstance | undefined;
  /** Better Auth's own messages go through the redacting logger, never straight to the console. */
  logger: Logger;
  plugins?: BetterAuthPlugin[];
}

// The fields of GitHub's /user response we keep; validated before use.
const githubProfileSchema = z.object({ login: z.string().min(1).max(39) });

export function createAuthOptions(config: AuthConfig) {
  return {
    appName: "PipeHeal",
    baseURL: config.baseURL,
    secret: config.secret,
    trustedOrigins: [config.baseURL],
    database: config.database,
    telemetry: { enabled: false },
    logger: {
      level: "warn",
      log: (level, message, ...details: unknown[]) => {
        config.logger[level]({ details }, message);
      },
    },
    emailAndPassword: { enabled: false },
    socialProviders: {
      github: {
        clientId: config.github.clientId,
        clientSecret: config.github.clientSecret,
        // GitHub App user tokens ignore OAuth scopes: access comes from the App's permissions
        // (SPEC §5.1, including "Email addresses: read", D9).
        disableDefaultScope: true,
        // Keep name, avatar and login current: GitHub logins can be renamed.
        overrideUserInfoOnSignIn: true,
        mapProfileToUser: (profile: unknown) => ({
          login: githubProfileSchema.parse(profile).login,
        }),
      },
    },
    user: {
      // Set from the GitHub profile at each sign-in (`input: false` would drop it there too).
      additionalFields: { login: { type: "string", required: false } },
    },
    // Over HTTP, these endpoints would hand decrypted GitHub tokens (usable on GitHub long after
    // sign-out) to anyone holding a session, or let users edit the profile fields other members
    // see. The server keeps using them through `auth.api`, which this list doesn't affect.
    disabledPaths: [...DISABLED_PATHS],
    account: {
      // D8: GitHub user tokens are kept for the OWNER check and onboarding, encrypted at rest
      // (XChaCha20-Poly1305, key = SHA-256 of the secret). Rotating the secret signs everyone out
      // and makes stored tokens unreadable.
      encryptOAuthTokens: true,
      // One sign-in method (GitHub): never attach a GitHub identity to an existing user by email.
      accountLinking: { enabled: false },
    },
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      // Better Auth skips its Origin and callback-URL checks by default when NODE_ENV=test or
      // TEST is set. Keep them on everywhere, tests included.
      disableOriginCheck: false,
    },
    plugins: config.plugins ?? [],
  } satisfies BetterAuthOptions;
}
