// The runner <-> gateway protocol (SPEC §3.1, §5.4, §7.2, D15). Both sides parse with these
// schemas; the server never trusts what the runner sends. Written before the implementation.
import { describe, expect, it } from "vitest";
import {
  LIMITS,
  sessionRequestSchema,
  sessionResponseSchema,
  stepPollResponseSchema,
  stepRequestSchema,
  submissionSchema,
  toolCallSchema,
} from "./protocol";

const ATTEMPT = "0196f0a0-0000-7000-8000-000000000001";
const SESSION = "a".repeat(43);

describe("session exchange", () => {
  it("accepts a JWT-shaped OIDC token and an attempt ID", () => {
    expect(
      sessionRequestSchema.safeParse({ oidcToken: "aaa.bbb.ccc", attemptId: ATTEMPT }).success,
    ).toBe(true);
    expect(sessionRequestSchema.safeParse({ oidcToken: "nope", attemptId: ATTEMPT }).success).toBe(
      false,
    );
    expect(
      sessionRequestSchema.safeParse({ oidcToken: "a.b.c", attemptId: ATTEMPT, extra: 1 }).success,
    ).toBe(false);
  });

  it("returns the session and what the runner needs to run the attempt", () => {
    const response = {
      sessionToken: SESSION,
      expiresAt: "2026-11-26T12:45:00.000Z",
      attempt: {
        targetSha: "c".repeat(40),
        failingCheck: "test",
        commands: { install: ["pnpm", "install"], test: ["pnpm", "test"] },
        junitGlob: "reports/**/*.xml",
        wallClockMinutes: 25,
      },
    };

    expect(sessionResponseSchema.parse(response)).toEqual(response);
    expect(
      sessionResponseSchema.safeParse({
        ...response,
        attempt: { ...response.attempt, commands: { test: "pnpm test" } },
      }).success,
    ).toBe(false);
  });
});

describe("tool calls (SPEC §7.2)", () => {
  it.each([
    { tool: "list_files", path: ".", depth: 2 },
    { tool: "read_file", path: "src/cart.ts", start: 1, end: 40 },
    { tool: "search_code", pattern: "total(", glob: "src/**" },
    { tool: "apply_edit", path: "src/cart.ts", oldStr: "a", newStr: "b" },
    { tool: "write_file", path: "src/new.ts", content: "export {};\n" },
    { tool: "run_check", name: "test_file", target: "src/cart.test.ts" },
    {
      tool: "submit_fix",
      rootCause: "total counted items",
      changes: "sum prices",
      verification: "tests pass",
      confidence: "high",
    },
    { tool: "give_up", diagnosis: "needs a secret", category: "config", suggestedNextStep: "x" },
  ])("accepts $tool", (call) => {
    expect(toolCallSchema.safeParse({ callId: "c1", ...call }).success).toBe(true);
  });

  it.each([
    ["a path outside the repo", { tool: "read_file", path: "../etc/passwd" }],
    ["an absolute path", { tool: "read_file", path: "/etc/passwd" }],
    ["a backslash path", { tool: "write_file", path: "src\\a.ts", content: "" }],
    ["an unknown check", { tool: "run_check", name: "deploy" }],
    ["an unknown tool", { tool: "shell", command: "rm -rf /" }],
    [
      "an oversized file",
      { tool: "write_file", path: "a.ts", content: "x".repeat(LIMITS.fileBytes + 1) },
    ],
    ["a missing call ID", { callId: undefined, tool: "list_files", path: "." }],
  ])("refuses %s", (_, call) => {
    expect(toolCallSchema.safeParse({ callId: "c1", ...call }).success).toBe(false);
  });
});

describe("steps (D15: async, long-polled)", () => {
  it("starts with the reproduction, the file tree and the baseline reports", () => {
    expect(
      stepRequestSchema.safeParse({
        stepSeq: 1,
        start: {
          reproduced: true,
          check: { name: "test", exitCode: 1, output: "1 failed" },
          fileTree: ["src/cart.ts", "src/cart.test.ts"],
          reports: [{ path: "reports/junit.xml", xml: "<testsuites/>" }],
        },
      }).success,
    ).toBe(true);
  });

  it("then carries tool results, and refuses a step that is both or neither", () => {
    const results = [{ callId: "c1", ok: true, output: "file contents" }];

    expect(stepRequestSchema.safeParse({ stepSeq: 2, toolResults: results }).success).toBe(true);
    expect(stepRequestSchema.safeParse({ stepSeq: 2 }).success).toBe(false);
    expect(stepRequestSchema.safeParse({ stepSeq: 0, toolResults: results }).success).toBe(false);
    expect(
      stepRequestSchema.safeParse({
        stepSeq: 2,
        toolResults: [{ callId: "c1", ok: true, output: "x".repeat(LIMITS.toolOutputChars + 1) }],
      }).success,
    ).toBe(false);
  });

  it("answers a poll with pending, the next tool calls, or done", () => {
    for (const answer of [
      { status: "pending", stepSeq: 2, retryAfterMs: 2_000 },
      { status: "ready", stepSeq: 2, toolCalls: [{ callId: "c2", tool: "list_files", path: "." }] },
      { status: "done", stepSeq: 2, outcome: "gave_up", reason: "needs a secret" },
    ]) {
      expect(stepPollResponseSchema.safeParse(answer).success).toBe(true);
    }
    expect(
      stepPollResponseSchema.safeParse({ status: "ready", stepSeq: 2, toolCalls: [] }).success,
    ).toBe(false);
  });
});

describe("submission", () => {
  it("carries final contents (never a diff), check results and reports", () => {
    const submission = {
      files: [
        { path: "src/cart.ts", content: "export const total = 1;\n" },
        { path: "src/old.ts", deleted: true },
      ],
      checks: [{ name: "test", exitCode: 0, output: "all passed" }],
      reports: [{ path: "reports/junit.xml", xml: "<testsuites/>" }],
    };

    expect(submissionSchema.parse(submission)).toEqual(submission);
    // Shape only: whether a path may be written is the policy engine's call on the server.
    expect(
      submissionSchema.safeParse({ ...submission, files: [{ path: ".github/x.yml", content: "" }] })
        .success,
    ).toBe(true);
    expect(
      submissionSchema.safeParse({
        ...submission,
        files: Array.from({ length: LIMITS.submissionFiles + 1 }, (_, i) => ({
          path: `f${String(i)}.ts`,
          content: "",
        })),
      }).success,
    ).toBe(false);
    expect(
      submissionSchema.safeParse({
        ...submission,
        files: [{ path: "a.ts", content: "x", deleted: true }],
      }).success,
    ).toBe(false);
  });
});
