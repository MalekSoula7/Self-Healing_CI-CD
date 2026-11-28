// heal-action's run (SPEC §2 steps 8-10, §5.3, §7.3). In this order, because the runner is not a
// sandbox: exchange the OIDC token for the attempt's session first, before any customer code runs;
// keep the session token in memory only; then install, reproduce the failing check, record the
// baseline test reports, and run the tool loop. On submit: run the full checks and upload the
// changed files' contents (never a diff: the server recomputes it, P5.1).
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { compileGlob, globMatches } from "@pipeheal/policy/glob";
import {
  LIMITS,
  sessionResponseSchema,
  type AttemptCommands,
  type CheckName,
  type CheckResult,
  type SessionResponse,
  type Submission,
} from "@pipeheal/shared/protocol";
import { z } from "zod";
import { runCommand, scrubbedEnv } from "./exec";
import { gatewayClient, type GatewayClient } from "./gateway";
import { executeTool } from "./tools";
import {
  openWorkspace,
  readBoundedText,
  resolvePath,
  trackedFiles,
  type Workspace,
} from "./workspace";

export const OIDC_AUDIENCE = "pipeheal";
/** A single check never runs longer than this, nor past the attempt's deadline. */
const CHECK_TIMEOUT_MS = 15 * 60_000;
const FINAL_CHECKS: readonly CheckName[] = ["build", "lint", "typecheck", "test"];

export interface RunDeps {
  env: NodeJS.ProcessEnv;
  /** The checkout of the target commit (actions/checkout with persist-credentials: false). */
  cwd: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log: (line: string) => void;
  /** For local mode (P4.6): an OIDC token is replaced by a session opened by the dev CLI. */
  session?: { token: string; details: SessionResponse };
  /**
   * Local mode only (P4.6): its container reaches the developer's gateway at
   * host.docker.internal over plain http. A GitHub runner never sets it.
   */
  plainHttpHosts?: readonly string[];
}

const oidcAnswerSchema = z.object({ value: z.string().min(1) });

/** A GitHub Actions OIDC token for PipeHeal's audience (needs `id-token: write`). */
export async function requestOidcToken(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (url === undefined || bearer === undefined) {
    throw new Error("no OIDC token available: the job needs `permissions: id-token: write`");
  }
  const target = new URL(url);
  target.searchParams.set("audience", OIDC_AUDIENCE);
  const response = await fetchImpl(target, {
    headers: { authorization: `Bearer ${bearer}` },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const answer = oidcAnswerSchema.safeParse(await response.json().catch(() => null));
  if (!response.ok || !answer.success) throw new Error("GitHub didn't issue an OIDC token");
  return answer.data.value;
}

/** Text from the model or the repository, safe to print in the job log (no workflow commands). */
export function printable(text: string): string {
  return text
    .replace(/::/g, ": :")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
}

function commandFor(commands: AttemptCommands, name: CheckName): readonly string[] | undefined {
  return name === "test_file" ? undefined : commands[name];
}

async function check(
  workspace: Workspace,
  commands: AttemptCommands,
  name: CheckName,
  timeoutMs: number,
): Promise<CheckResult | null> {
  const argv = commandFor(commands, name);
  if (argv === undefined) return null;
  const result = await runCommand(argv, {
    cwd: workspace.root,
    env: workspace.env,
    timeoutMs,
    maxOutputChars: LIMITS.toolOutputChars,
  });
  return { name, exitCode: result.exitCode, output: result.output };
}

/** JUnit reports under the checkout matching the repository's glob (SPEC §8.6), bounded. */
export async function collectReports(
  workspace: Workspace,
  glob: string | null,
): Promise<Submission["reports"]> {
  const compiled = glob === null ? null : compileGlob(glob);
  if (compiled === null) return [];
  const reports: Submission["reports"] = [];
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 8 || reports.length >= LIMITS.reports) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (reports.length >= LIMITS.reports) return;
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), `${path}/`, depth + 1);
      } else if (entry.isFile() && globMatches(compiled, path)) {
        const full = join(dir, entry.name);
        if ((await stat(full)).size > LIMITS.reportChars) continue;
        reports.push({ path, xml: await readFile(full, "utf8") });
      }
    }
  };
  await walk(workspace.root, "", 0);
  return reports;
}

/**
 * The final contents of the files the model's edits wrote, and only those (P4.5 review M4):
 * whatever else changed on disk (build output, files code under test dropped) never leaves the
 * runner. Each one is checked again as a plain regular file inside the checkout before it is read.
 */
async function submissionFiles(
  workspace: Workspace,
  touched: ReadonlySet<string>,
): Promise<Submission["files"]> {
  const files: Submission["files"] = [];
  for (const path of [...touched].sort().slice(0, LIMITS.submissionFiles)) {
    const target = await resolvePath(workspace, path, { write: true });
    const info = await lstat(target).catch(() => null);
    if (info === null) {
      files.push({ path, deleted: true });
      continue;
    }
    if (!info.isFile() || info.nlink > 1) throw new Error(`${path} isn't a plain file any more`);
    files.push({ path, content: await readBoundedText(target, path, LIMITS.fileBytes) });
  }
  return files;
}

async function loop(
  client: GatewayClient,
  token: string,
  workspace: Workspace,
  session: SessionResponse,
  deadline: Date,
  log: (line: string) => void,
  touched: Set<string>,
) {
  const remaining = () => Math.max(1_000, deadline.getTime() - Date.now());
  const { commands } = session.attempt;
  const timeout = () => Math.min(CHECK_TIMEOUT_MS, remaining());

  // Install, then reproduce: a failing install is itself the evidence.
  const install = await check(workspace, commands, "install", timeout());
  let reproduction = install;
  if ((install === null || install.exitCode === 0) && session.attempt.failingCheck !== "install") {
    reproduction = await check(workspace, commands, session.attempt.failingCheck, timeout());
  }
  const start = reproduction ?? {
    name: session.attempt.failingCheck,
    exitCode: null,
    output: `no ${session.attempt.failingCheck} command is configured`,
  };
  log(`reproduced the failure: ${String(start.exitCode !== 0)}`);
  await client.postStep(token, {
    stepSeq: 1,
    start: {
      reproduced: start.exitCode !== 0,
      check: start,
      fileTree: await trackedFiles(workspace),
      reports: await collectReports(workspace, session.attempt.junitGlob),
    },
  });

  for (let stepSeq = 1; ; stepSeq++) {
    const poll = await client.waitForStep(token, stepSeq, deadline);
    if (poll.status === "done") return poll;
    if (poll.status !== "ready") continue;
    const toolResults = [];
    for (const call of poll.toolCalls) {
      toolResults.push(
        await executeTool(call, { workspace, commands, checkTimeoutMs: timeout(), touched }),
      );
    }
    log(`step ${String(stepSeq)}: ran ${String(toolResults.length)} tool calls`);
    await client.postStep(token, { stepSeq: stepSeq + 1, toolResults });
  }
}

/** The action's run; returns the process exit code. */
export async function run(deps: RunDeps): Promise<number> {
  const { env, log } = deps;
  const attemptId = env["INPUT_JOB-ID"] ?? env.INPUT_JOB_ID;
  const gatewayUrl = env["INPUT_GATEWAY-URL"] ?? env.INPUT_GATEWAY_URL;
  if (attemptId === undefined || gatewayUrl === undefined) {
    log("::error::heal-action needs the job-id and gateway-url inputs");
    return 1;
  }
  // The OIDC token and session token travel to it: https only, loopback aside (local mode).
  const target = URL.parse(gatewayUrl);
  const loopback = target !== null && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
  if (
    target === null ||
    (target.protocol !== "https:" &&
      !(
        (loopback || (deps.plainHttpHosts ?? []).includes(target.hostname)) &&
        target.protocol === "http:"
      ))
  ) {
    log("::error::gateway-url must be an https URL");
    return 1;
  }
  const client = gatewayClient({
    baseUrl: gatewayUrl,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
  });
  try {
    // First, before any customer code: the session (SPEC §5.3). Its token stays in memory.
    let token: string;
    let session: SessionResponse;
    if (deps.session === undefined) {
      const oidcToken = await requestOidcToken(env, deps.fetchImpl);
      // Masked in the job log, should any future line ever include them (review L8).
      log(`::add-mask::${oidcToken}`);
      const opened = await client.openSession(oidcToken, attemptId);
      log(`::add-mask::${opened.sessionToken}`);
      token = opened.sessionToken;
      session = opened;
    } else {
      token = deps.session.token;
      session = deps.session.details;
    }
    const deadline = new Date(
      Math.min(
        new Date(session.expiresAt).getTime(),
        Date.now() + session.attempt.wallClockMinutes * 60_000,
      ),
    );
    const workspace = await openWorkspace(deps.cwd, scrubbedEnv(env));
    const touched = new Set<string>();
    const end = await loop(client, token, workspace, session, deadline, log, touched);
    log(`the loop ended: ${end.outcome} (${printable(end.reason)})`);
    if (end.outcome !== "submit") return 0;

    const checks: CheckResult[] = [];
    for (const name of FINAL_CHECKS) {
      const result = await check(
        workspace,
        session.attempt.commands,
        name,
        Math.min(CHECK_TIMEOUT_MS, Math.max(1_000, deadline.getTime() - Date.now())),
      );
      if (result !== null) checks.push(result);
    }
    const files = await submissionFiles(workspace, touched);
    if (files.length === 0) {
      log("::warning::the model submitted a fix without changing any file");
      return 1;
    }
    await client.submit(token, {
      files,
      checks,
      reports: await collectReports(workspace, session.attempt.junitGlob),
    });
    log(`submitted ${String(files.length)} changed files`);
    return 0;
  } catch (error) {
    log(`::error::heal-action failed: ${printable(error instanceof Error ? error.message : "")}`);
    return 1;
  }
}

const localSessionSchema = z.object({
  attemptId: z.uuid(),
  token: z.string().min(32).max(256),
  details: sessionResponseSchema,
});
export type LocalSession = z.infer<typeof localSessionSchema>;

/** Local mode's session, as `pnpm heal:local` passes it: base64 JSON (P4.6). */
export function readLocalSession(encoded: string | undefined): LocalSession | null {
  if (encoded === undefined) return null;
  try {
    const parsed = localSessionSchema.safeParse(
      JSON.parse(Buffer.from(encoded, "base64").toString("utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
