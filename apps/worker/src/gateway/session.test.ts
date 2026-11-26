// POST /v1/session (SPEC §5.4): the route around the verifier. The database side is faked here
// (its own rules are in packages/db's runner-sessions tests); tokens are signed with local keys.
import type { AttemptForSession, SessionRef } from "@pipeheal/db";
import { createLogger } from "@pipeheal/shared/logger";
import { sessionResponseSchema } from "@pipeheal/shared/protocol";
import { describe, expect, it } from "vitest";
import { buildGateway } from "./server";
import { SESSION_RATE_LIMIT, hashSessionToken, registerSessionRoute } from "./session";
import {
  APP_SLUG,
  ATTEMPT_ID,
  CLAIMS,
  OWNER_ID,
  REPO_ID,
  attemptFor,
  oidcKit,
} from "./testing/oidc";

const kit = await oidcKit();

interface Setup {
  attempt?: AttemptForSession | null;
  /** What `open` answers: null when another exchange won. */
  opens?: boolean;
  appSlug?: string | undefined;
  /** The repository's wall-clock budget in minutes. */
  wallClock?: number;
}

async function gateway(setup: Setup = {}) {
  const { attempt = attemptFor(), opens = true, wallClock = 25 } = setup;
  // An explicit `appSlug: undefined` means "not configured", so no default for it.
  const appSlug = "appSlug" in setup ? setup.appSlug : APP_SLUG;
  const lines: string[] = [];
  const logger = createLogger({ level: "info", service: "test" }, { write: (l) => lines.push(l) });
  const calls: {
    find: SessionRef[];
    open: { ref: SessionRef; tokenHash: string; ttlMs: number | undefined }[];
    contest: SessionRef[];
  } = { find: [], open: [], contest: [] };
  const app = await buildGateway({ logger });
  registerSessionRoute(app, {
    sessions: {
      find: (ref) => {
        calls.find.push(ref);
        return Promise.resolve(attempt);
      },
      open: (ref, session) => {
        calls.open.push({ ref, tokenHash: session.tokenHash, ttlMs: session.ttlMs });
        return Promise.resolve(
          opens
            ? {
                attemptId: ATTEMPT_ID,
                orgId: "o",
                expiresAt: new Date(session.now.getTime() + (session.ttlMs ?? 0)),
              }
            : null,
        );
      },
      contest: (ref) => {
        calls.contest.push(ref);
        return Promise.resolve(true);
      },
    },
    keys: kit.keys,
    appSlug,
    wallClockMinutes: () => Promise.resolve(wallClock),
  });
  const exchange = async (body: unknown, remoteAddress = "203.0.113.1") =>
    app.inject({ method: "POST", url: "/v1/session", payload: body as object, remoteAddress });
  return { app, calls, lines, exchange };
}

describe("POST /v1/session", () => {
  it("opens the session and returns what the runner needs", async () => {
    const { app, calls, lines, exchange } = await gateway();
    const oidcToken = await kit.sign();

    const response = await exchange({ oidcToken, attemptId: ATTEMPT_ID });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = sessionResponseSchema.parse(response.json());
    expect(body.attempt).toEqual({
      targetSha: "c".repeat(40),
      failingCheck: "test",
      commands: { install: ["pnpm", "install"], test: ["pnpm", "test"] },
      junitGlob: "reports/*.xml",
      wallClockMinutes: 25,
    });
    expect(body.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Looked up through the signed IDs; only the token's hash reaches the database.
    expect(calls.find).toEqual([
      { attemptId: ATTEMPT_ID, githubRepoId: REPO_ID, githubOwnerId: OWNER_ID },
    ]);
    expect(calls.open.map((call) => call.tokenHash)).toEqual([hashSessionToken(body.sessionToken)]);
    // The session ends with the attempt's wall-clock budget.
    expect(calls.open.map((call) => call.ttlMs)).toEqual([25 * 60_000]);
    expect(calls.contest).toEqual([]);
    const logs = lines.join("");
    expect(logs).toContain("session opened");
    expect(logs).not.toContain(body.sessionToken);
    expect(logs).not.toContain(oidcToken);
  });

  it("never lets the budget outlast the 45-minute session", async () => {
    const { app, calls, exchange } = await gateway({ wallClock: 90 });

    const response = await exchange({ oidcToken: await kit.sign(), attemptId: ATTEMPT_ID });
    await app.close();

    expect(sessionResponseSchema.parse(response.json()).attempt.wallClockMinutes).toBe(45);
    expect(calls.open.map((call) => call.ttlMs)).toEqual([45 * 60_000]);
  });

  it("contests a second exchange from the dispatched run instead of just refusing it", async () => {
    const { app, calls, lines, exchange } = await gateway({
      attempt: attemptFor({ status: "RUNNING", sessionTokenHash: "a".repeat(64) }),
    });

    const response = await exchange({ oidcToken: await kit.sign(), attemptId: ATTEMPT_ID });
    await app.close();

    expect(response.statusCode).toBe(401);
    expect(calls.contest).toEqual([
      { attemptId: ATTEMPT_ID, githubRepoId: REPO_ID, githubOwnerId: OWNER_ID },
    ]);
    expect(calls.open).toEqual([]);
    expect(lines.join("")).toContain("session contested");
  });

  it("doesn't contest for a token from another run", async () => {
    const { app, calls, exchange } = await gateway({
      attempt: attemptFor({ status: "RUNNING", sessionTokenHash: "a".repeat(64) }),
    });

    await exchange({
      oidcToken: await kit.sign({ ...CLAIMS, run_id: "778" }),
      attemptId: ATTEMPT_ID,
    });
    await app.close();

    expect(calls.contest).toEqual([]);
  });

  it("refuses, without opening a session, when the stored attempt doesn't fit the protocol", async () => {
    const { app, calls, exchange } = await gateway({
      attempt: attemptFor({ repo: { junitGlob: "" } }),
    });

    const response = await exchange({ oidcToken: await kit.sign(), attemptId: ATTEMPT_ID });
    await app.close();

    expect(response.statusCode).toBe(401);
    expect(calls.open).toEqual([]);
  });

  it("treats stored commands that aren't argv arrays as not configured", async () => {
    const { app, exchange } = await gateway({
      attempt: attemptFor({ repo: { commands: { test: "pnpm test && curl evil" } } }),
    });

    const response = await exchange({ oidcToken: await kit.sign(), attemptId: ATTEMPT_ID });
    await app.close();

    expect(sessionResponseSchema.parse(response.json()).attempt.commands).toEqual({});
  });

  it.each([
    ["no body", undefined],
    ["a token that isn't a JWT", { oidcToken: "nope", attemptId: ATTEMPT_ID }],
    ["an attempt ID that isn't a UUID", { oidcToken: "a.b.c", attemptId: "1" }],
    ["extra fields", { oidcToken: "a.b.c", attemptId: ATTEMPT_ID, sessionToken: "x" }],
  ])("answers 400 to %s", async (_, body) => {
    const { app, calls, exchange } = await gateway();

    const response = await exchange(body);
    await app.close();

    expect(response.statusCode).toBe(400);
    expect(calls.find).toEqual([]);
  });

  it("answers 503 when the App isn't configured, before verifying anything", async () => {
    const { app, calls, exchange } = await gateway({ appSlug: undefined });

    const response = await exchange({ oidcToken: await kit.sign(), attemptId: ATTEMPT_ID });
    await app.close();

    expect(response.statusCode).toBe(503);
    expect(calls.find).toEqual([]);
  });

  it.each<[string, () => Promise<string>, Setup]>([
    ["a token that doesn't verify", () => kit.sign(CLAIMS, { audience: "other" }), {}],
    ["an attempt of another repository", () => kit.sign(), { attempt: null }],
    ["a dispatch by someone else", () => kit.sign({ ...CLAIMS, actor: "octocat" }), {}],
    [
      "an attempt whose dispatch run isn't recorded",
      () => kit.sign(),
      { attempt: attemptFor({ dispatchRunId: null }) },
    ],
    ["an exchange that lost the race", () => kit.sign(), { opens: false }],
  ])("answers the same 401 to %s, logging why", async (_, token, setup) => {
    const { app, lines, exchange } = await gateway(setup);
    const oidcToken = await token();

    const response = await exchange({ oidcToken, attemptId: ATTEMPT_ID });
    await app.close();

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "session refused" });
    const logs = lines.join("");
    expect(logs).toContain("session refused");
    expect(logs).toMatch(/"reason":"[^"]+"/);
    expect(logs).not.toContain(oidcToken);
  });

  it("never opens a session for a refused token", async () => {
    const { app, calls, exchange } = await gateway();

    await exchange({
      oidcToken: await kit.sign({ ...CLAIMS, event_name: "push" }),
      attemptId: ATTEMPT_ID,
    });
    await app.close();

    expect(calls.open).toEqual([]);
  });

  it("limits exchanges per client address", async () => {
    const { app, exchange } = await gateway({ attempt: null });
    const body = { oidcToken: "a.b.c", attemptId: ATTEMPT_ID };
    const statuses: number[] = [];

    for (let i = 0; i <= SESSION_RATE_LIMIT.max; i += 1) {
      statuses.push((await exchange(body, "198.51.100.9")).statusCode);
    }
    const elsewhere = (await exchange(body, "198.51.100.10")).statusCode;
    await app.close();

    expect(statuses.slice(0, -1).every((status) => status === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect(elsewhere).toBe(401);
  });

  it("refuses a body over the session limit unread", async () => {
    const { app, calls, exchange } = await gateway();

    const response = await exchange({
      oidcToken: `a.${"b".repeat(20_000)}.c`,
      attemptId: ATTEMPT_ID,
    });
    await app.close();

    expect(response.statusCode).toBe(413);
    expect(calls.find).toEqual([]);
  });
});
