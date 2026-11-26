// SPEC §5.4: what a runner's OIDC token must prove before it gets a session. Tokens are signed
// with locally generated keys; GitHub's JWKS endpoint is served by msw.
import { mockServer } from "@pipeheal/shared/testing";
import { SignJWT, generateKeyPair } from "jose";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import {
  GITHUB_OIDC_JWKS_URL,
  githubOidcKeys,
  sessionProblem,
  verifyOidcToken,
  type OidcClaims,
} from "./oidc";
import { APP_SLUG, CLAIMS, OWNER_ID, REPO_ID, RUN_ID, attemptFor, oidcKit } from "./testing/oidc";

const kit = await oidcKit();
const now = () => Math.floor(Date.now() / 1000);

describe("verifyOidcToken", () => {
  it("accepts GitHub's token and reads the claims a session needs", async () => {
    const result = await verifyOidcToken(await kit.sign(), kit.keys);

    expect(result).toEqual({
      ok: true,
      claims: {
        repository: "acme/app",
        repository_id: REPO_ID,
        repository_owner_id: OWNER_ID,
        event_name: "workflow_dispatch",
        ref: "refs/heads/main",
        workflow_ref: CLAIMS.workflow_ref,
        job_workflow_ref: CLAIMS.workflow_ref,
        actor: `${APP_SLUG}[bot]`,
        run_id: RUN_ID,
        run_attempt: 1,
      },
    });
  });

  it.each([
    ["another issuer", { issuer: "https://token.actions.example.com" }, "claim iss: check_failed"],
    ["another audience", { audience: "sts.amazonaws.com" }, "claim aud: check_failed"],
    ["an expired token", { expiresAt: now() - 120 }, "ERR_JWT_EXPIRED"],
    [
      "a token older than GitHub ever issues",
      { issuedAt: now() - 3_600, expiresAt: now() + 3_600 },
      "ERR_JWT_EXPIRED",
    ],
    ["a token issued in the future", { issuedAt: now() + 3_600 }, "claim iat: check_failed"],
    ["an unknown key", { kid: "unknown" }, "ERR_JWKS_NO_MATCHING_KEY"],
  ])("refuses %s", async (_, options, reason) => {
    const result = await verifyOidcToken(await kit.sign(CLAIMS, options), kit.keys);

    expect(result).toEqual({ ok: false, reason });
  });

  it("refuses a token signed with someone else's key under GitHub's key ID", async () => {
    const forger = await generateKeyPair("RS256");

    const result = await verifyOidcToken(
      await kit.sign(CLAIMS, { key: forger.privateKey }),
      kit.keys,
    );

    expect(result).toEqual({ ok: false, reason: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" });
  });

  it("refuses unsigned and HMAC tokens", async () => {
    const hmac = await new SignJWT(CLAIMS)
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setIssuer("https://token.actions.githubusercontent.com")
      .setAudience("pipeheal")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("x".repeat(32)));
    const [header = "", payload = ""] = (await kit.sign()).split(".");
    const unsigned = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${payload}.`;

    for (const token of [hmac, unsigned, `${header}.${payload}.`, "not-a-jwt"]) {
      expect((await verifyOidcToken(token, kit.keys)).ok).toBe(false);
    }
  });

  it("refuses missing or malformed claims", async () => {
    const withoutRepo = Object.fromEntries(
      Object.entries(CLAIMS).filter(([key]) => key !== "repository_id"),
    );

    for (const claims of [
      withoutRepo,
      { ...CLAIMS, repository_id: 101 },
      { ...CLAIMS, run_id: "0" },
      { ...CLAIMS, repository: "not a repo" },
    ]) {
      expect(await verifyOidcToken(await kit.sign(claims), kit.keys)).toEqual({
        ok: false,
        reason: "missing or malformed claims",
      });
    }
  });

  it("fetches GitHub's published keys once and caches them", async () => {
    let fetched = 0;
    mockServer.use(
      http.get(GITHUB_OIDC_JWKS_URL, () => {
        fetched += 1;
        return HttpResponse.json({ keys: [kit.jwk] });
      }),
    );
    const keys = githubOidcKeys();

    const first = await verifyOidcToken(await kit.sign(), keys);
    const second = await verifyOidcToken(await kit.sign(), keys);

    expect(first.ok && second.ok).toBe(true);
    expect(fetched).toBe(1);
  });

  it("refuses every token when GitHub's keys can't be fetched", async () => {
    mockServer.use(http.get(GITHUB_OIDC_JWKS_URL, () => new HttpResponse(null, { status: 503 })));

    const result = await verifyOidcToken(await kit.sign(), githubOidcKeys());

    expect(result.ok).toBe(false);
  });
});

describe("sessionProblem", async () => {
  const verified = await verifyOidcToken(await kit.sign(), kit.keys);
  if (!verified.ok) throw new Error("test setup: fixture token didn't verify");
  const claims: OidcClaims = verified.claims;
  const context = { appSlug: APP_SLUG, now: new Date(), dispatchTimeoutMs: 15 * 60_000 };

  it("accepts the App's dispatch of the healer on the default branch", () => {
    expect(sessionProblem(claims, attemptFor(), context)).toBeNull();
    // The bot login's case doesn't matter.
    expect(sessionProblem({ ...claims, actor: "PipeHeal[bot]" }, attemptFor(), context)).toBeNull();
  });

  it.each<[string, Partial<OidcClaims>, Parameters<typeof attemptFor>[0], string]>([
    ["a suspended organization", {}, { org: { status: "SUSPENDED" } }, "organization not active"],
    ["a disabled repository", {}, { repo: { enabled: false } }, "repository not enabled"],
    [
      "a repository removed from the installation",
      {},
      { repo: { removedFromInstallationAt: new Date() } },
      "repository not enabled",
    ],
    ["a push run", { event_name: "push" }, {}, "not a workflow_dispatch run"],
    [
      "a pull_request_target run",
      { event_name: "pull_request_target" },
      {},
      "not a workflow_dispatch run",
    ],
    [
      "a dispatch on a feature branch",
      {
        ref: "refs/heads/evil",
        workflow_ref: "acme/app/.github/workflows/pipeheal.yml@refs/heads/evil",
      },
      {},
      "not the default branch",
    ],
    [
      "a renamed default branch",
      {},
      { repo: { defaultBranch: "trunk" } },
      "not the default branch",
    ],
    [
      "another workflow file",
      { workflow_ref: "acme/app/.github/workflows/ci.yml@refs/heads/main" },
      {},
      "not the healer workflow",
    ],
    [
      "the healer of another repository",
      { workflow_ref: "evil/app/.github/workflows/pipeheal.yml@refs/heads/main" },
      {},
      "not the healer workflow",
    ],
    [
      "the healer pinned to a tag",
      { workflow_ref: "acme/app/.github/workflows/pipeheal.yml@refs/tags/v1" },
      {},
      "not the healer workflow",
    ],
    ["a dispatch by a person", { actor: "octocat" }, {}, "not dispatched by the App"],
    ["a dispatch by another App", { actor: "other-app[bot]" }, {}, "not dispatched by the App"],
    [
      "a reusable workflow's job",
      { job_workflow_ref: "other/repo/.github/workflows/x.yml@refs/heads/main" },
      {},
      "not the healer's own job",
    ],
    ["another run of the healer", { run_id: 778n }, {}, "not the dispatched run"],
    [
      "an attempt whose dispatch run isn't recorded (D16)",
      {},
      { dispatchRunId: null },
      "dispatch run not recorded yet",
    ],
    ["a re-run of the dispatched run", { run_attempt: 2 }, {}, "a re-run of the dispatched run"],
    [
      "an attempt with a session",
      {},
      { sessionTokenHash: "a".repeat(64), status: "RUNNING" },
      "attempt already has a session",
    ],
    ["a failed attempt", {}, { status: "FAILED" }, "attempt not waiting for a runner"],
    [
      "an expired dispatch",
      {},
      { dispatchedAt: new Date(Date.now() - 16 * 60_000) },
      "dispatch expired",
    ],
  ])("refuses %s", (_, claimOverrides, attemptOverrides, reason) => {
    expect(
      sessionProblem({ ...claims, ...claimOverrides }, attemptFor(attemptOverrides), context),
    ).toBe(reason);
  });

  it("refuses when no attempt matches the signed repository", () => {
    expect(sessionProblem(claims, null, context)).toBe("no such attempt for this repository");
  });
});
