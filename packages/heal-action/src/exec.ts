// Running commands in the customer's runner (SPEC §5.3, §7.2). Commands come only from the
// repository's configuration, as argv arrays: never through a shell. Checks run with a scrubbed
// environment (no OIDC request credentials, no runtime tokens, no GitHub tokens, no file-command
// channels, no action inputs), a timeout that kills the whole process tree, and bounded output.
// This narrows what code under test can reach; it isn't a sandbox (SPEC §5.3, D20).
import { spawn } from "node:child_process";

/** Variables code under test must never see. Case-insensitive: Windows names are. */
const SECRET_VARIABLES = [
  /^ACTIONS_ID_TOKEN_REQUEST_/i,
  /^ACTIONS_RUNTIME_/i,
  /^ACTIONS_CACHE_URL$/i,
  /^ACTIONS_RESULTS_URL$/i,
  /^ACTIONS_(STEP|RUNNER)_DEBUG$/i,
  /^(GITHUB|GH)_TOKEN$/i,
  // File-command channels: a child could set later steps' env, PATH, outputs or the summary.
  /^GITHUB_(ENV|PATH|OUTPUT|STATE|STEP_SUMMARY)$/i,
  /^INPUT_/i,
  /^PIPEHEAL_/i,
];

/** The environment without anything that could act as the job or reach PipeHeal. */
export function scrubbedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !SECRET_VARIABLES.some((pattern) => pattern.test(key))),
  );
}

export interface CommandResult {
  /** 0-255, or null when the command was killed (timeout) or couldn't start. */
  exitCode: number | null;
  /** Stdout and stderr interleaved as written, within `maxOutputChars`. */
  output: string;
  timedOut: boolean;
  /** Output was cut to `maxOutputChars`. */
  truncated: boolean;
}

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputChars: number;
  /** Which part to keep when the output is too long: the end (logs) or the start (diffs). */
  keep?: "head" | "tail";
}

/** How long to wait for output after the process exited, when a descendant keeps a pipe open. */
const DRAIN_MS = 2_000;

/** Kills the process and everything it started (it leads its own process group). */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // Already gone.
  }
}

/** Exit codes outside the protocol's 0-255 (Windows NTSTATUS codes) map to 255. */
function protocolCode(code: number | null): number | null {
  if (code === null) return null;
  return code >= 0 && code <= 255 ? code : 255;
}

/** Runs `argv` without a shell; resolves whatever happens, never rejects. */
export function runCommand(argv: readonly string[], options: RunOptions): Promise<CommandResult> {
  const [program, ...args] = argv;
  if (program === undefined) {
    return Promise.resolve({
      exitCode: null,
      output: "no command",
      timedOut: false,
      truncated: false,
    });
  }
  const keep = options.keep ?? "tail";
  return new Promise((resolve) => {
    let output = "";
    let truncated = false;
    let total = 0;
    const take = (chunk: Buffer) => {
      total += chunk.length;
      if (keep === "head") {
        if (output.length < options.maxOutputChars) output += chunk.toString("utf8");
        if (output.length > options.maxOutputChars) {
          output = output.slice(0, options.maxOutputChars);
          truncated = true;
        } else if (total > options.maxOutputChars * 4) {
          truncated = true;
        }
        return;
      }
      output += chunk.toString("utf8");
      // Twice the limit before trimming, so trimming stays cheap on chatty commands.
      if (output.length > options.maxOutputChars * 2) {
        output = output.slice(-options.maxOutputChars);
        truncated = true;
      }
    };
    let timedOut = false;
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      // Its own process group, so a timeout or the end can kill everything it started.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let finished = false;
    // `error` and `exit`/`close` can both fire; resolve once.
    const finish = (exitCode: number | null, note?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      killTree(child.pid);
      child.stdout.destroy();
      child.stderr.destroy();
      let text = output;
      if (keep === "tail" && text.length > options.maxOutputChars) {
        text = text.slice(-options.maxOutputChars);
        truncated = true;
      }
      if (keep === "tail" && truncated) text = `[earlier output omitted]\n${text}`;
      if (note !== undefined) text = `${text}${text === "" ? "" : "\n"}${note}`;
      resolve({
        exitCode: timedOut ? null : protocolCode(exitCode),
        output: text,
        timedOut,
        truncated,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      finish(null, `killed after ${String(options.timeoutMs)} ms`);
    }, options.timeoutMs);
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (error) => {
      finish(null, `couldn't start ${program}: ${error.message}`);
    });
    child.on("close", (code) => {
      finish(code);
    });
    // A descendant can keep the pipes open after the process exited: don't wait for it.
    child.on("exit", (code) => {
      setTimeout(() => {
        finish(code);
      }, DRAIN_MS).unref();
    });
  });
}
