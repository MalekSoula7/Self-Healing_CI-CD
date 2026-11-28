// GitHub Actions OIDC tokens (SPEC §5.4). The token proves which repository's workflow run asks
// for a session; everything a runner sends besides it is untrusted. Verification is split in two:
// the signature and standard claims (`verifyOidcToken`), then what the claims must say about the
// attempt (`sessionProblem`, pure, so every rejection path is unit tested).
import type { AttemptForSession } from "@pipeheal/db";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_OIDC_JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
/** The audience heal-action requests its token for. */
export const OIDC_AUDIENCE = "pipeheal";
/** Fixed in v1 (SPEC §5.3). */
export const HEALER_WORKFLOW_PATH = ".github/workflows/pipeheal.yml";
/** Tolerated clock skew between GitHub and us. */
const CLOCK_TOLERANCE_S = 30;
/** GitHub's tokens live minutes; an older one (or one issued in the future) is refused. */
const MAX_TOKEN_AGE = "15m";

/** GitHub's signing keys, fetched and cached by jose (refetched on an unknown key ID). */
export function githubOidcKeys(): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(GITHUB_OIDC_JWKS_URL), {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  });
}

const numericId = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .transform(BigInt);

/** The claims a session needs. GitHub adds others over time, so unknown ones are ignored. */
const claimsSchema = z.object({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  repository_id: numericId,
  repository_owner_id: numericId,
  event_name: z.string().max(100),
  ref: z.string().max(1_000),
  workflow_ref: z.string().max(2_000),
  /** The workflow file of the job that asked for the token: a reusable workflow's, if any. */
  job_workflow_ref: z.string().max(2_000),
  actor: z.string().max(200),
  run_id: numericId,
  run_attempt: z
    .string()
    .regex(/^[1-9]\d{0,4}$/)
    .transform(Number),
});
export type OidcClaims = z.output<typeof claimsSchema>;

export type VerifyResult = { ok: true; claims: OidcClaims } | { ok: false; reason: string };

/**
 * Checks the token's RS256 signature against GitHub's keys, its issuer, audience and expiry, and
 * reads the claims a session needs. The reason is safe to log; the token never is.
 */
export async function verifyOidcToken(
  token: string,
  keys: JWTVerifyGetKey,
  now: Date = new Date(),
): Promise<VerifyResult> {
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: GITHUB_OIDC_ISSUER,
      audience: OIDC_AUDIENCE,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat"],
      clockTolerance: CLOCK_TOLERANCE_S,
      maxTokenAge: MAX_TOKEN_AGE,
      currentDate: now,
    });
    const claims = claimsSchema.safeParse(payload);
    if (!claims.success) return { ok: false, reason: "missing or malformed claims" };
    return { ok: true, claims: claims.data };
  } catch (error) {
    if (error instanceof joseErrors.JWTClaimValidationFailed) {
      return { ok: false, reason: `claim ${error.claim}: ${error.reason}` };
    }
    if (error instanceof joseErrors.JOSEError) return { ok: false, reason: error.code };
    return { ok: false, reason: "token verification failed" };
  }
}

/** The problem that means the attempt's own run asked twice: the session is contested. */
export const SESSION_TAKEN = "attempt already has a session";

export interface SessionContext {
  /** The GitHub App's slug: our dispatches run as `<slug>[bot]`. */
  appSlug: string;
  now: Date;
  dispatchTimeoutMs: number;
}

/**
 * Why these verified claims can't open a session on this attempt, or null when they can
 * (SPEC §5.4). The attempt was looked up through the claims' repository and owner IDs.
 */
export function sessionProblem(
  claims: OidcClaims,
  attempt: AttemptForSession | null,
  context: SessionContext,
): string | null {
  if (attempt === null) return "no such attempt for this repository";
  const { repo } = attempt.failure;
  if (attempt.org.status !== "ACTIVE") return "organization not active";
  if (!repo.enabled || repo.removedFromInstallationAt !== null) return "repository not enabled";
  if (claims.event_name !== "workflow_dispatch") return "not a workflow_dispatch run";
  // We always dispatch on the default branch, so a feature branch can't change the healer.
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  if (claims.ref !== defaultRef) return "not the default branch";
  if (claims.workflow_ref !== `${claims.repository}/${HEALER_WORKFLOW_PATH}@${defaultRef}`) {
    return "not the healer workflow";
  }
  // The token's job must be the healer's own, not a reusable workflow it calls from elsewhere.
  if (claims.job_workflow_ref !== claims.workflow_ref) return "not the healer's own job";
  // Only the App's own dispatches can open a session.
  if (claims.actor.toLowerCase() !== `${context.appSlug}[bot]`.toLowerCase()) {
    return "not dispatched by the App";
  }
  // The run ID is what ties a token to this attempt rather than another one in the same
  // repository (D16): without it every healer run of the repo would qualify.
  if (attempt.dispatchRunId === null) return "dispatch run not recorded yet";
  if (claims.run_id !== attempt.dispatchRunId) return "not the dispatched run";
  // A re-run is started by whoever clicks "Re-run" but keeps the bot as actor: refuse it.
  if (claims.run_attempt !== 1) return "a re-run of the dispatched run";
  if (attempt.sessionTokenHash !== null) return SESSION_TAKEN;
  if (attempt.status !== "DISPATCHED") return "attempt not waiting for a runner";
  if (context.now.getTime() - attempt.dispatchedAt.getTime() > context.dispatchTimeoutMs) {
    return "dispatch expired";
  }
  return null;
}
