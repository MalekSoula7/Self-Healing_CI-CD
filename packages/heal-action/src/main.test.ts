// heal-action end to end in a real checkout, against a gateway served by msw (SPEC §5.3, §7.3, D15):
// the session first, before any customer code; then install, reproduce, the tool loop, the final
// checks and a submission of file contents.
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionResponseSchema } from "@pipeheal/shared/protocol";
import { mockServer } from "@pipeheal/shared/testing";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "./exec";
import { collectReports, printable, readLocalSession, requestOidcToken, run } from "./main";
import { openWorkspace } from "./workspace";

const NL = String.fromCharCode(10);
const NODE = process.execPath;
// Loopback: plain http is refused anywhere else.
const GATEWAY = "http://127.0.0.1:4999";
const OIDC = "http://token.actions.test/oidc?api-version=2.0";
const ATTEMPT = "0196f0a0-0000-7000-8000-0000000000a1";
const SESSION = "s".repeat(43);
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "heal-run-"));
  await mkdir(join(root, "src"));
  await writeFile(
    join(root, "src", "cart.js"),
    ["exports.total = (xs) => xs.length;", ""].join(NL),
  );
  // The "test": fails until total sums prices.
  await writeFile(
    join(root, "test.js"),
    [
      "const { total } = require('./src/cart.js');",
      "require('fs').mkdirSync('reports', { recursive: true });",
      "require('fs').writeFileSync('reports/junit.xml', '<testsuite><testcase name=\"t\"/></testsuite>');",
      "process.exit(total([{ price: 2 }, { price: 3 }]) === 5 ? 0 : 1);",
    ].join(NL),
  );
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "t@example.test"],
    ["config", "user.name", "T"],
    ["config", "core.autocrlf", "false"],
    ["add", "-A"],
    ["commit", "-q", "-m", "init"],
  ]) {
    await runCommand(["git", ...args], {
      cwd: root,
      env: process.env,
      timeoutMs: 30_000,
      maxOutputChars: 1_000,
    });
  }
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function session(overrides: Record<string, unknown> = {}) {
  return {
    sessionToken: SESSION,
    expiresAt: new Date(Date.now() + 45 * 60_000).toISOString(),
    attempt: {
      targetSha: "c".repeat(40),
      failingCheck: "test",
      commands: {
        // Leaves a marker: the session must have been opened before it runs.
        install: [NODE, "-e", "require('fs').writeFileSync('installed', '')"],
        test: [NODE, "test.js"],
      },
      junitGlob: "reports/*.xml",
      wallClockMinutes: 5,
      ...overrides,
    },
  };
}

interface Gateway {
  steps: unknown[];
  submissions: unknown[];
  sessionsAsked: number;
  installedAtSession: boolean[];
}

/** A gateway that answers each poll from a script, and records what the runner sent. */
function gateway(polls: unknown[], options: { firstSession401?: boolean } = {}): Gateway {
  const state: Gateway = { steps: [], submissions: [], sessionsAsked: 0, installedAtSession: [] };
  mockServer.use(
    http.get("http://token.actions.test/oidc", ({ request }) => {
      const url = new URL(request.url);
      return url.searchParams.get("audience") === "pipeheal" &&
        request.headers.get("authorization") === "Bearer request-token"
        ? HttpResponse.json({ value: "aaa.bbb.ccc" })
        : HttpResponse.json({}, { status: 403 });
    }),
    http.post(`${GATEWAY}/v1/session`, async ({ request }) => {
      state.sessionsAsked += 1;
      state.installedAtSession.push(existsSync(join(root, "installed")));
      const body = (await request.json()) as { oidcToken: string; attemptId: string };
      if (options.firstSession401 === true && state.sessionsAsked === 1) {
        return HttpResponse.json({ error: "session refused" }, { status: 401 });
      }
      return body.oidcToken === "aaa.bbb.ccc" && body.attemptId === ATTEMPT
        ? HttpResponse.json(session())
        : HttpResponse.json({ error: "session refused" }, { status: 401 });
    }),
    http.post(`${GATEWAY}/v1/step`, async ({ request }) => {
      const body = (await request.json()) as { stepSeq: number };
      state.steps.push(body);
      return HttpResponse.json({ stepSeq: body.stepSeq }, { status: 202 });
    }),
    http.get(`${GATEWAY}/v1/step/:seq`, ({ request }) => {
      expect(request.headers.get("authorization")).toBe(`Bearer ${SESSION}`);
      const next = polls.shift();
      return next === undefined
        ? HttpResponse.json({ error: "no such step" }, { status: 404 })
        : HttpResponse.json(next);
    }),
    http.post(`${GATEWAY}/v1/submission`, async ({ request }) => {
      state.submissions.push(await request.json());
      return HttpResponse.json({ ok: true }, { status: 202 });
    }),
  );
  return state;
}

const env = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  "INPUT_JOB-ID": ATTEMPT,
  "INPUT_GATEWAY-URL": GATEWAY,
  ACTIONS_ID_TOKEN_REQUEST_URL: OIDC,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
};

const runAction = (lines: string[] = []) =>
  run({ env, cwd: root, sleep: () => Promise.resolve(), log: (line) => lines.push(line) });

describe("run", () => {
  it("opens the session first, reproduces, runs the tools, checks and submits contents", async () => {
    const state = gateway(
      [
        { status: "pending", stepSeq: 1, retryAfterMs: 1 },
        {
          status: "ready",
          stepSeq: 1,
          toolCalls: [
            {
              callId: "s1c1-abcd1234",
              tool: "apply_edit",
              path: "src/cart.js",
              oldStr: "xs.length",
              newStr: "xs.reduce((sum, x) => sum + x.price, 0)",
            },
          ],
        },
        { status: "done", stepSeq: 2, outcome: "submit", reason: "sums prices" },
      ],
      { firstSession401: true },
    );

    const code = await runAction();

    expect(code).toBe(0);
    // Retried once while the run was being recorded, and before install ran.
    expect(state.sessionsAsked).toBe(2);
    expect(state.installedAtSession).toEqual([false, false]);
    expect(state.steps[0]).toMatchObject({
      stepSeq: 1,
      start: {
        reproduced: true,
        check: { name: "test", exitCode: 1 },
        fileTree: ["src/cart.js", "test.js"],
        reports: [{ path: "reports/junit.xml" }],
      },
    });
    expect(state.steps[1]).toMatchObject({
      stepSeq: 2,
      toolResults: [
        {
          callId: "s1c1-abcd1234",
          ok: true,
          output: expect.stringContaining("diff --git") as string,
        },
      ],
    });
    expect(state.submissions).toHaveLength(1);
    expect(state.submissions[0]).toMatchObject({
      checks: [{ name: "test", exitCode: 0 }],
      files: expect.arrayContaining([
        { path: "src/cart.js", content: await readFile(join(root, "src", "cart.js"), "utf8") },
      ]) as unknown,
    });
    // Never the runner's diff: contents only.
    expect(JSON.stringify(state.submissions[0])).not.toContain("diff --git");
  });

  it("stops at the reproduction when the failure doesn't reproduce", async () => {
    await writeFile(join(root, "test.js"), "process.exit(0);");
    const state = gateway([
      { status: "done", stepSeq: 1, outcome: "not_reproducible", reason: "passed" },
    ]);

    expect(await runAction()).toBe(0);
    expect(state.steps[0]).toMatchObject({ start: { reproduced: false } });
    expect(state.submissions).toEqual([]);
  });

  it("fails clearly without its inputs, or when the session is refused", async () => {
    const lines: string[] = [];
    expect(await run({ env: {}, cwd: root, log: (line) => lines.push(line) })).toBe(1);
    expect(lines[0]).toContain("job-id and gateway-url");
    const insecure: string[] = [];
    expect(
      await run({
        env: { ...env, "INPUT_GATEWAY-URL": "http://gateway.example.com" },
        cwd: root,
        log: (line) => insecure.push(line),
      }),
    ).toBe(1);
    expect(insecure[0]).toContain("must be an https URL");

    mockServer.use(
      http.get("http://token.actions.test/oidc", () => HttpResponse.json({ value: "x.y.z" })),
      http.post(`${GATEWAY}/v1/session`, () =>
        HttpResponse.json({ error: "session refused" }, { status: 401 }),
      ),
    );
    const refused: string[] = [];
    expect(await runAction(refused)).toBe(1);
    expect(refused.at(-1)).toContain("session refused");
    expect(existsSync(join(root, "installed"))).toBe(false);
  });
});

describe("helpers", () => {
  it("asks GitHub for an OIDC token for PipeHeal's audience", async () => {
    gateway([]);

    await expect(requestOidcToken(env)).resolves.toBe("aaa.bbb.ccc");
    await expect(requestOidcToken({})).rejects.toThrow("id-token: write");
  });

  it("never prints model or repository text as a workflow command", () => {
    expect(printable("::set-output name=x::1" + NL + "::error::fake")).not.toMatch(/(^|\s)::/);
  });

  it("collects only reports matching the glob, outside node_modules and .git", async () => {
    await mkdir(join(root, "reports"), { recursive: true });
    await mkdir(join(root, "node_modules", "x", "reports"), { recursive: true });
    await writeFile(join(root, "reports", "a.xml"), "<testsuite/>");
    await writeFile(join(root, "reports", "a.txt"), "no");
    await writeFile(join(root, "node_modules", "x", "reports", "b.xml"), "<testsuite/>");
    const workspace = await openWorkspace(root, process.env);

    expect((await collectReports(workspace, "**/reports/*.xml")).map((r) => r.path)).toEqual([
      "reports/a.xml",
    ]);
    expect(await collectReports(workspace, null)).toEqual([]);
  });
});

describe("local mode (P4.6)", () => {
  it("reads the session the CLI passes, and nothing malformed", () => {
    const local = { attemptId: ATTEMPT, token: SESSION, details: session() };
    const encoded = Buffer.from(JSON.stringify(local)).toString("base64");

    expect(readLocalSession(encoded)).toEqual(local);
    expect(readLocalSession(undefined)).toBeNull();
    expect(readLocalSession("not base64 json")).toBeNull();
    expect(
      readLocalSession(Buffer.from(JSON.stringify({ ...local, token: "x" })).toString("base64")),
    ).toBeNull();
  });

  it("allows a plain-http gateway only when local mode asks", async () => {
    const state = gateway([{ status: "done", stepSeq: 1, outcome: "stopped", reason: "cap" }]);
    const hostEnv = { ...env, "INPUT_GATEWAY-URL": "http://host.docker.internal:4000" };
    mockServer.use(
      http.post("http://host.docker.internal:4000/v1/step", async ({ request }) => {
        state.steps.push(await request.json());
        return HttpResponse.json({ stepSeq: 1 }, { status: 202 });
      }),
      http.get("http://host.docker.internal:4000/v1/step/:seq", () =>
        HttpResponse.json({ status: "done", stepSeq: 1, outcome: "stopped", reason: "cap" }),
      ),
    );
    const refused: string[] = [];

    expect(await run({ env: hostEnv, cwd: root, log: (line) => refused.push(line) })).toBe(1);
    expect(
      await run({
        env: hostEnv,
        cwd: root,
        log: () => undefined,
        session: { token: SESSION, details: sessionResponseSchema.parse(session()) },
        plainHttpHosts: ["host.docker.internal"],
      }),
    ).toBe(0);
    expect(refused[0]).toContain("must be an https URL");
    // The session came from the CLI: no OIDC request, no exchange.
    expect(state.sessionsAsked).toBe(0);
    expect(state.steps).toHaveLength(1);
  });
});
