// The tool executor (SPEC §7.2): the agent's hands in the customer's runner. Each call was
// validated against the protocol on the way in; here it is carried out within the checkout, with
// output cut to the protocol's limit. A refused or failed call is an `ok: false` result the model
// reads, never a crash. There is no shell, network or environment tool, and checks run only the
// repository's configured commands, as argv arrays, with the scrubbed environment. The paths the
// model's edits touch are recorded: they, and only they, are what a fix submits (review M4).
import { mkdir, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  LIMITS,
  type AttemptCommands,
  type ToolCall,
  type ToolResult,
} from "@pipeheal/shared/protocol";
import { runCommand } from "./exec";
import {
  ToolError,
  cumulativeDiff,
  isFile,
  readBoundedText,
  resolvePath,
  writeRegularFile,
  type Workspace,
} from "./workspace";

export interface ExecutorOptions {
  workspace: Workspace;
  commands: AttemptCommands;
  /** A check's time limit; the attempt's own wall clock bounds it too. */
  checkTimeoutMs: number;
  /** Repo paths the model's edits wrote, filled in by the executor. */
  touched: Set<string>;
}

const MAX_LISTED = 500;
const MAX_SEARCH_LINES = 200;

/** Output within the protocol's limit, saying when it was cut. */
function bounded(callId: string, ok: boolean, output: string, cut = false): ToolResult {
  if (output.length <= LIMITS.toolOutputChars) {
    return cut ? { callId, ok, output, truncated: true } : { callId, ok, output };
  }
  const note = "\n[output cut to fit the protocol's limit]";
  return {
    callId,
    ok,
    output: output.slice(0, LIMITS.toolOutputChars - note.length) + note,
    truncated: true,
  };
}

async function listFiles(workspace: Workspace, path: string, depth: number): Promise<string> {
  const start = await resolvePath(workspace, path, { write: false });
  const lines: string[] = [];
  const walk = async (dir: string, prefix: string, level: number): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (lines.length >= MAX_LISTED) return;
      if (entry.name.toLowerCase() === ".git") continue;
      const shown = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        lines.push(`${shown}/`);
        if (level < depth) await walk(`${dir}/${entry.name}`, `${shown}/`, level + 1);
      } else if (!entry.isSymbolicLink()) {
        lines.push(shown);
      }
    }
  };
  await walk(start, path === "." ? "" : `${path}/`, 1);
  if (lines.length >= MAX_LISTED) lines.push(`[stopped at ${String(MAX_LISTED)} entries]`);
  return lines.length === 0 ? "(empty)" : lines.join("\n");
}

async function readLines(
  workspace: Workspace,
  path: string,
  start?: number,
  end?: number,
): Promise<string> {
  const target = await resolvePath(workspace, path, { write: false });
  const text = await readBoundedText(target, path, LIMITS.fileBytes);
  if (start === undefined && end === undefined) return text;
  const lines = text.split("\n");
  const from = Math.max(1, start ?? 1);
  const to = Math.min(lines.length, end ?? lines.length);
  if (from > to) throw new ToolError(`${path}: lines ${String(from)}-${String(to)} are empty`);
  return [
    `[lines ${String(from)}-${String(to)} of ${String(lines.length)}]`,
    ...lines.slice(from - 1, to),
  ].join("\n");
}

async function searchCode(workspace: Workspace, pattern: string, glob?: string): Promise<string> {
  const args = ["grep", "-n", "-I", "-F", "--no-color", "--no-textconv", "-e", pattern];
  if (glob !== undefined) args.push("--", `:(glob)${glob}`);
  const result = await workspace.git(args);
  if (result.exitCode === 1) return "(no matches)";
  if (result.exitCode !== 0) throw new ToolError("the search failed");
  const lines = result.output.split("\n").filter((line) => line !== "");
  return lines.length > MAX_SEARCH_LINES
    ? [
        ...lines.slice(0, MAX_SEARCH_LINES),
        `[${String(lines.length - MAX_SEARCH_LINES)} more matches]`,
      ].join("\n")
    : lines.join("\n");
}

async function applyEdit(
  options: ExecutorOptions,
  path: string,
  oldStr: string,
  newStr: string,
): Promise<{ diff: string; truncated: boolean }> {
  const target = await resolvePath(options.workspace, path, { write: true });
  const text = await readBoundedText(target, path, LIMITS.fileBytes);
  const first = text.indexOf(oldStr);
  if (first === -1) throw new ToolError(`${path}: old_str doesn't appear in the file`);
  if (text.includes(oldStr, first + 1)) {
    throw new ToolError(`${path}: old_str appears more than once; include more context`);
  }
  const next = text.slice(0, first) + newStr + text.slice(first + oldStr.length);
  if (next.length > LIMITS.fileBytes) throw new ToolError(`${path}: the edit makes it too large`);
  await writeRegularFile(target, path, next);
  options.touched.add(path);
  return diffOutput(options);
}

async function writeWhole(
  options: ExecutorOptions,
  path: string,
  content: string,
): Promise<{ diff: string; truncated: boolean }> {
  const target = await resolvePath(options.workspace, path, { write: true });
  await mkdir(dirname(target), { recursive: true });
  // Created directories can't have been links: check the path again before writing.
  await resolvePath(options.workspace, path, { write: true });
  await writeRegularFile(target, path, content);
  options.touched.add(path);
  return diffOutput(options);
}

/** What every edit returns: the cumulative diff, which the server checks against the policy. */
async function diffOutput(options: ExecutorOptions): Promise<{ diff: string; truncated: boolean }> {
  const { diff, truncated } = await cumulativeDiff(options.workspace, options.touched);
  return { diff: diff === "" ? "(no changes)" : diff, truncated };
}

async function runCheck(
  options: ExecutorOptions,
  name: string,
  target: string | undefined,
): Promise<{ ok: boolean; output: string }> {
  const { commands, workspace } = options;
  let argv: readonly string[] | undefined;
  if (name === "test_file") {
    if (target === undefined) throw new ToolError("test_file needs a target test file");
    const path = await resolvePath(workspace, target, { write: false });
    if (!(await isFile(path))) throw new ToolError(`${target}: no such file`);
    argv = commands.testFile === undefined ? undefined : [...commands.testFile, target];
  } else {
    argv = commands[name as Exclude<keyof AttemptCommands, "testFile">];
  }
  if (argv === undefined) {
    throw new ToolError(`no ${name} command is configured for this repository`);
  }
  const result = await runCommand(argv, {
    cwd: workspace.root,
    env: workspace.env,
    timeoutMs: options.checkTimeoutMs,
    maxOutputChars: LIMITS.toolOutputChars - 100,
  });
  const status = result.timedOut
    ? "timed out"
    : `exit code ${result.exitCode === null ? "none" : String(result.exitCode)}`;
  return { ok: result.exitCode === 0, output: `${status}\n${result.output}` };
}

/** Carries out one tool call. submit_fix and give_up never reach the runner (they end the loop). */
export async function executeTool(call: ToolCall, options: ExecutorOptions): Promise<ToolResult> {
  const { workspace } = options;
  try {
    switch (call.tool) {
      case "list_files":
        return bounded(call.callId, true, await listFiles(workspace, call.path, call.depth ?? 2));
      case "read_file":
        return bounded(
          call.callId,
          true,
          await readLines(workspace, call.path, call.start, call.end),
        );
      case "search_code":
        return bounded(call.callId, true, await searchCode(workspace, call.pattern, call.glob));
      case "apply_edit": {
        const edit = await applyEdit(options, call.path, call.oldStr, call.newStr);
        return bounded(call.callId, true, edit.diff, edit.truncated);
      }
      case "write_file": {
        const edit = await writeWhole(options, call.path, call.content);
        return bounded(call.callId, true, edit.diff, edit.truncated);
      }
      case "run_check": {
        const result = await runCheck(options, call.name, call.target);
        return bounded(call.callId, result.ok, result.output);
      }
      default:
        return bounded(call.callId, false, `${call.tool} isn't a tool the runner carries out`);
    }
  } catch (error) {
    if (error instanceof ToolError) return bounded(call.callId, false, error.message);
    // Anything else (a file system error): its message, without paths outside the checkout.
    const message = error instanceof Error ? error.message.split(workspace.root).join(".") : "";
    return bounded(call.callId, false, `the tool failed: ${message.slice(0, 300)}`);
  }
}
