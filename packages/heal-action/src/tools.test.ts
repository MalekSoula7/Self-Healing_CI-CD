// The tool executor in a real git checkout (SPEC §7.2): what each tool does, and what it refuses.
// Checks run Node itself as the configured command, as argv.
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttemptCommands, ToolCall } from "@pipeheal/shared/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCommand, scrubbedEnv } from "./exec";
import { executeTool } from "./tools";
import { openWorkspace, type Workspace } from "./workspace";

const NL = String.fromCharCode(10);
const NODE = process.execPath;
let root: string;
let outside: string;
let workspace: Workspace;

async function git(...args: string[]) {
  const result = await runCommand(["git", ...args], {
    cwd: root,
    env: process.env,
    timeoutMs: 30_000,
    maxOutputChars: 10_000,
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.output}`);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "heal-action-"));
  outside = await mkdtemp(join(tmpdir(), "heal-outside-"));
  await writeFile(join(outside, "secret.txt"), "not yours");
  await mkdir(join(root, "src"));
  await writeFile(
    join(root, "src", "cart.ts"),
    ["export const total = (xs) =>", "  xs.length;", ""].join(NL),
  );
  await writeFile(join(root, "src", "dup.ts"), ["a", "a", ""].join(NL));
  await writeFile(join(root, "README.md"), "# shop" + NL);
  await writeFile(join(root, "bin.dat"), Buffer.from([1, 0, 2]));
  await writeFile(
    join(root, "check.js"),
    "process.exit(process.argv[2] === 'src/cart.ts' ? 0 : 3);",
  );
  await git("init", "-q");
  await git("config", "user.email", "test@example.test");
  await git("config", "user.name", "Test");
  await git("config", "core.autocrlf", "false");
  await git("add", "-A");
  await git("commit", "-q", "-m", "init");
  // Directory links out of the checkout and into .git (a junction needs no privileges on
  // Windows), and a hard link to a file outside it.
  const dirLink = process.platform === "win32" ? "junction" : "dir";
  await symlink(outside, join(root, "link"), dirLink);
  await symlink(join(root, ".git"), join(root, "gitlink"), dirLink);
  await link(join(outside, "secret.txt"), join(root, "hard.txt"));
  workspace = await openWorkspace(
    root,
    scrubbedEnv({ ...process.env, GITHUB_TOKEN: "ghs_secret" }),
  );
}, 60_000);

afterAll(async () => {
  // A killed check's process tree can take a moment to let go of the directory on Windows.
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await rm(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const commands: AttemptCommands = {
  test: [NODE, "-e", "process.exit(1)"],
  lint: [NODE, "-e", "console.log(process.env.GITHUB_TOKEN ?? 'no token')"],
  build: [NODE, "-e", "setTimeout(() => {}, 20000)"],
  testFile: [NODE, "check.js"],
};

const touched = new Set<string>();
const run = (call: Record<string, unknown>) =>
  executeTool({ callId: "c1", ...call } as ToolCall, {
    workspace,
    commands,
    checkTimeoutMs: 1_000,
    touched,
  });

describe("reading", () => {
  it("lists files, skipping .git", async () => {
    const result = await run({ tool: "list_files", path: ".", depth: 2 });

    expect(result.ok).toBe(true);
    expect(result.output.split(NL)).toEqual(
      expect.arrayContaining(["README.md", "src/", "src/cart.ts"]),
    );
    expect(result.output).not.toContain(".git");
  });

  it("reads a file, or some of its lines", async () => {
    expect(await run({ tool: "read_file", path: "README.md" })).toEqual({
      callId: "c1",
      ok: true,
      output: "# shop" + NL,
    });
    expect((await run({ tool: "read_file", path: "src/dup.ts", start: 2, end: 2 })).output).toBe(
      ["[lines 2-2 of 3]", "a"].join(NL),
    );
  });

  it.each([
    ["a missing file", "nope.ts", "no such file"],
    ["a binary file", "bin.dat", "a binary file"],
    ["the .git directory", ".git/config", "off limits"],
    ["a path out of the repo", "../etc/passwd", "not a repository-relative"],
    ["a link that leads out", "link/secret.txt", "leads out of the repository"],
    ["a link into .git", "gitlink/config", "off limits"],
    ["the .git directory spelled otherwise", ".GIT/config", "off limits"],
  ])("refuses %s", async (_, path, message) => {
    const result = await run({ tool: "read_file", path });

    expect(result.ok).toBe(false);
    expect(result.output).toContain(message);
  });

  it("searches the code with git grep, as a fixed string", async () => {
    expect((await run({ tool: "search_code", pattern: "export const total" })).output).toBe(
      "src/cart.ts:1:export const total = (xs) =>",
    );
    expect((await run({ tool: "search_code", pattern: "(", glob: "*.md" })).output).toBe(
      "(no matches)",
    );
  });
});

describe("editing", () => {
  it("replaces a unique string and returns the cumulative diff", async () => {
    const result = await run({
      tool: "apply_edit",
      path: "src/cart.ts",
      oldStr: "xs.length",
      newStr: "xs.reduce((sum, x) => sum + x.price, 0)",
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("diff --git a/src/cart.ts b/src/cart.ts");
    expect(result.output).toContain("-  xs.length;");
    await expect(readFile(join(root, "src", "cart.ts"), "utf8")).resolves.toContain("reduce");
  });

  it("writes a new file, which shows in the diff", async () => {
    const result = await run({
      tool: "write_file",
      path: "src/new/util.ts",
      content: "export {};" + NL,
    });

    expect(result.output).toContain("diff --git a/src/new/util.ts b/src/new/util.ts");
    expect(result.output).toContain("src/cart.ts");
  });

  it.each([
    ["a missing string", { path: "README.md", oldStr: "nope", newStr: "x" }, "doesn't appear"],
    ["an ambiguous string", { path: "src/dup.ts", oldStr: "a", newStr: "b" }, "more than once"],
    [
      "a file under .github",
      { path: ".github/workflows/x.yml", oldStr: "a", newStr: "b" },
      ".github",
    ],
    [
      "a file through a link out",
      { path: "link/secret.txt", oldStr: "not", newStr: "is" },
      "won't write through a symlink",
    ],
  ])("refuses to edit %s", async (_, edit, message) => {
    const result = await run({ tool: "apply_edit", ...edit });

    expect(result.ok).toBe(false);
    expect(result.output).toContain(message);
    await expect(readFile(join(outside, "secret.txt"), "utf8")).resolves.toBe("not yours");
  });

  it("refuses to write under .github or .git, through links, or into a hard link", async () => {
    for (const path of [
      ".github/workflows/evil.yml",
      "src/.git/hooks/pre-commit",
      "gitlink/hooks/pre-commit",
      "link/new.txt",
      "hard.txt",
    ]) {
      expect((await run({ tool: "write_file", path, content: "x" })).ok).toBe(false);
    }
    await expect(readFile(join(outside, "secret.txt"), "utf8")).resolves.toBe("not yours");
  });

  it("records the paths its edits wrote, and only those", () => {
    expect([...touched].sort()).toEqual(["src/cart.ts", "src/new/util.ts"]);
  });
});

describe("run_check", () => {
  it("runs the configured command and reports its exit code", async () => {
    const result = await run({ tool: "run_check", name: "test" });

    expect(result).toMatchObject({ ok: false });
    expect(result.output.startsWith("exit code 1")).toBe(true);
  });

  it("runs checks without the job's secrets", async () => {
    const result = await run({ tool: "run_check", name: "lint" });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("no token");
    expect(result.output).not.toContain("ghs_secret");
  });

  it("appends the target to the test_file command, which must exist", async () => {
    expect((await run({ tool: "run_check", name: "test_file", target: "src/cart.ts" })).ok).toBe(
      true,
    );
    expect(
      (await run({ tool: "run_check", name: "test_file", target: "nope.ts" })).output,
    ).toContain("no such file");
    expect((await run({ tool: "run_check", name: "test_file" })).ok).toBe(false);
  });

  it("refuses a check that isn't configured, and stops one that runs too long", async () => {
    expect((await run({ tool: "run_check", name: "typecheck" })).output).toContain(
      "no typecheck command is configured",
    );
    const slow = await run({ tool: "run_check", name: "build" });
    expect(slow.ok).toBe(false);
    expect(slow.output.startsWith("timed out")).toBe(true);
  });
});

describe("scrubbedEnv", () => {
  it("drops the job's credentials, runtime tokens and action inputs", () => {
    expect(
      scrubbedEnv({
        PATH: "/bin",
        HOME: "/home/runner",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://x",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t",
        ACTIONS_RUNTIME_TOKEN: "t",
        ACTIONS_CACHE_URL: "https://c",
        GITHUB_TOKEN: "ghs_x",
        "INPUT_JOB-ID": "id",
        PIPEHEAL_SESSION: "s",
      }),
    ).toEqual({ PATH: "/bin", HOME: "/home/runner" });
  });
});
