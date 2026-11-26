// Test kit for the session exchange: locally generated RS256 keys standing in for GitHub's, tokens
// signed with them, and the attempt a session would be opened on.
import type { AttemptForSession } from "@pipeheal/db";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
} from "jose";
import { GITHUB_OIDC_ISSUER, HEALER_WORKFLOW_PATH, OIDC_AUDIENCE } from "../oidc";

export const APP_SLUG = "pipeheal";
export const REPO_ID = 101n;
export const OWNER_ID = 202n;
export const RUN_ID = 777n;
export const ATTEMPT_ID = "0196f0a0-0000-7000-8000-0000000000a1";

/** The claims GitHub signs for a healer run we dispatched (SPEC §5.4). */
export const CLAIMS = {
  repository: "acme/app",
  repository_id: String(REPO_ID),
  repository_owner_id: String(OWNER_ID),
  event_name: "workflow_dispatch",
  ref: "refs/heads/main",
  workflow_ref: `acme/app/${HEALER_WORKFLOW_PATH}@refs/heads/main`,
  job_workflow_ref: `acme/app/${HEALER_WORKFLOW_PATH}@refs/heads/main`,
  actor: `${APP_SLUG}[bot]`,
  run_id: String(RUN_ID),
  run_attempt: "1",
  sub: "repo:acme/app:ref:refs/heads/main",
};

export interface SignOptions {
  issuer?: string;
  audience?: string;
  /** Seconds since the epoch. */
  issuedAt?: number;
  expiresAt?: number;
  key?: CryptoKey;
  kid?: string;
}

export async function oidcKit() {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const keys = createLocalJWKSet({ keys: [jwk] });

  async function sign(claims: Record<string, unknown> = CLAIMS, options: SignOptions = {}) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: options.kid ?? "k1" })
      .setIssuer(options.issuer ?? GITHUB_OIDC_ISSUER)
      .setAudience(options.audience ?? OIDC_AUDIENCE)
      .setIssuedAt(options.issuedAt ?? now)
      .setExpirationTime(options.expiresAt ?? now + 300)
      .sign(options.key ?? pair.privateKey);
  }

  return { keys, jwk, sign };
}

export interface AttemptOverrides extends Partial<Omit<AttemptForSession, "org" | "failure">> {
  org?: Partial<AttemptForSession["org"]>;
  repo?: Partial<AttemptForSession["failure"]["repo"]>;
}

/** A dispatched attempt on an enabled repository whose default branch is `main`. */
export function attemptFor(overrides: AttemptOverrides = {}): AttemptForSession {
  const { org, repo, ...attempt } = overrides;
  return {
    id: ATTEMPT_ID,
    orgId: "0196f0a0-0000-7000-8000-0000000000b2",
    status: "DISPATCHED",
    targetSha: "c".repeat(40),
    failingCheck: "test",
    dispatchRunId: RUN_ID,
    dispatchedAt: new Date(),
    sessionTokenHash: null,
    ...attempt,
    org: { status: "ACTIVE", ...org },
    failure: {
      repo: {
        id: "0196f0a0-0000-7000-8000-0000000000c3",
        fullName: "acme/app",
        defaultBranch: "main",
        enabled: true,
        removedFromInstallationAt: null,
        commands: { install: ["pnpm", "install"], test: ["pnpm", "test"] },
        junitGlob: "reports/*.xml",
        ...repo,
      },
    },
  };
}
