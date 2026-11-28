// Running configured commands (P4.5 security review M1, L4, L7): a child that leaves something
// running can't hang the action, long output is cut where it should be, and exit codes stay in
// the protocol's range.
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runCommand } from "./exec";

const NODE = process.execPath;
const NL = String.fromCharCode(10);
const options = { cwd: tmpdir(), env: process.env, timeoutMs: 10_000, maxOutputChars: 1_000 };

describe("runCommand", () => {
  it("finishes when the command exits, even if what it started keeps the output open", async () => {
    // The grandchild inherits stdout and would hold the pipe for a minute.
    const script = [
      "const { spawn } = require('child_process');",
      "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit', detached: true }).unref();",
      "console.log('started');",
    ].join(NL);
    const started = Date.now();

    const result = await runCommand([NODE, "-e", script], options);

    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.output).toContain("started");
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 20_000);

  it("kills a command that runs too long", async () => {
    const result = await runCommand([NODE, "-e", "setTimeout(() => {}, 60000)"], {
      ...options,
      timeoutMs: 300,
    });

    expect(result).toMatchObject({ exitCode: null, timedOut: true });
  }, 20_000);

  it("keeps the end of long output by default, or its start", async () => {
    const script = "process.stdout.write('S' + 'x'.repeat(5000) + 'E')";

    const tail = await runCommand([NODE, "-e", script], options);
    const head = await runCommand([NODE, "-e", script], { ...options, keep: "head" });

    expect(tail.output.endsWith("E")).toBe(true);
    expect(tail.output.startsWith("[earlier output omitted]")).toBe(true);
    expect(head.output.startsWith("S")).toBe(true);
    expect(head.output.length).toBe(1_000);
    expect([tail.truncated, head.truncated]).toEqual([true, true]);
  });

  it("keeps exit codes in the protocol's range", async () => {
    expect((await runCommand([NODE, "-e", "process.exit(3)"], options)).exitCode).toBe(3);
    const big = await runCommand([NODE, "-e", "process.exit(300)"], options);
    expect(big.exitCode).toBeLessThanOrEqual(255);
  });

  it("reports a command that can't start, and an empty command", async () => {
    expect(await runCommand(["no-such-program-pipeheal"], options)).toMatchObject({
      exitCode: null,
    });
    expect(await runCommand([], options)).toMatchObject({ exitCode: null, output: "no command" });
  });
});
