// The healer's model turn (P4.4): what it asks HEAL_MODEL, and what it makes of each answer. The
// Ollama client is faked with responses in Ollama's own shape; tests never call a real model.
import type { HealBrief, TimelineEvent } from "@pipeheal/agent-core";
import type { AgentEvent } from "@pipeheal/db";
import { effectivePolicy } from "@pipeheal/policy";
import { createLogger } from "@pipeheal/shared/logger";
import { describe, expect, it } from "vitest";
import { HEAL_CONTEXT_TOKENS, checkEdits, healTurnRunner, type HealInputs } from "./heal-runner";
import type { OllamaChatRequest, OllamaChatResponse, OllamaClient } from "./ollama";

const logger = createLogger({ level: "silent", service: "test" });
const policy = effectivePolicy({}).policy;
const BRIEF: HealBrief = {
  repo: { fullName: "acme/shop", defaultBranch: "main", language: "TypeScript" },
  commands: { test: ["pnpm", "test"] },
  failingCheck: "test",
  failure: { category: "test", summary: "total wrong", headBranch: "main" },
  jobs: [{ name: "test", failedStep: "Test", summary: null, errorWindow: "FAIL cart" }],
  recentChanges: null,
};
const STARTED = new Date("2026-11-27T10:00:00Z");
const NOW = new Date("2026-11-27T10:05:00Z");

function answer(message: Partial<OllamaChatResponse["message"]>, tokens = 50): OllamaChatResponse {
  return {
    model: "qwen3:14b",
    message: { role: "assistant", content: "", ...message },
    done: true,
    done_reason: "stop",
    prompt_eval_count: tokens * 10,
    eval_count: tokens,
  };
}

const call = (name: string, args: Record<string, unknown>) => ({
  function: { name, arguments: args },
});

function setup(
  answers: OllamaChatResponse[],
  inputs: HealInputs | null = { brief: BRIEF, policy, startedAt: STARTED },
) {
  const requests: OllamaChatRequest[] = [];
  const client: OllamaClient = {
    chat: (request) => {
      // A copy: the runner extends its conversation after a nudge.
      requests.push({ ...request, messages: [...request.messages] });
      const next = answers.shift();
      return next === undefined ? Promise.reject(new Error("no answer")) : Promise.resolve(next);
    },
    hasModel: () => Promise.resolve(true),
  };
  const runner = healTurnRunner({
    client,
    model: "qwen3:14b",
    load: () => Promise.resolve(inputs),
    logger,
    now: () => NOW,
  });
  const next = (history: AgentEvent[] = [], stepSeq = 1) =>
    runner.next({ orgId: "o", attemptId: "a", stepSeq, history });
  return { requests, next };
}

let seq = 0;
function stored(type: TimelineEvent["type"], stepSeq: number, payload: object): AgentEvent {
  seq += 1;
  return {
    id: `e${String(seq)}`,
    orgId: "o",
    attemptId: "a",
    seq,
    stepSeq,
    type,
    payload,
    createdAt: NOW,
  };
}

const START = stored("INFO", 1, {
  kind: "start",
  reproduced: true,
  check: { name: "test", exitCode: 1, output: "1 failed" },
  fileTree: ["src/cart.ts"],
  reports: [],
});

const DIFF = (path: string) =>
  [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    "@@ -0,0 +1,1 @@",
    "+on: push",
    "",
  ].join("\n");

describe("healTurnRunner", () => {
  it("asks HEAL_MODEL with the tools and the 16k context, and returns its calls", async () => {
    const { requests, next } = setup([
      answer({
        content: "The total sums counts.",
        tool_calls: [call("read_file", { path: "src/cart.ts" })],
      }),
    ]);

    const result = await next([START]);

    expect(result).toMatchObject({
      toolCalls: [{ tool: "read_file", path: "src/cart.ts" }],
      model: {
        model: "qwen3:14b",
        promptVersion: "heal-v2",
        inputTokens: 500,
        outputTokens: 50,
        text: "The total sums counts.",
      },
      policyChecks: [],
    });
    const [request] = requests;
    expect(request?.options).toMatchObject({ num_ctx: HEAL_CONTEXT_TOKENS });
    expect(request?.think).toBe(true);
    expect(request?.tools?.length).toBe(8);
    expect(request?.messages[0]?.content).toContain("[INV-GITHUB-DIR]");
    expect(request?.messages[1]?.content).toContain("<ci_log");
  });

  it("ends the loop on submit_fix and give_up", async () => {
    const submit = setup([
      answer({
        tool_calls: [
          call("submit_fix", {
            root_cause: "summed counts",
            changes: "sum prices",
            verification: "tests pass",
            confidence: "high",
          }),
        ],
      }),
    ]);
    const giveUp = setup([
      answer({
        tool_calls: [
          call("give_up", {
            diagnosis: "needs a secret",
            category: "config",
            suggested_next_step: "add it",
          }),
        ],
      }),
    ]);

    expect(await submit.next([START])).toMatchObject({
      done: "submit",
      reason:
        "Root cause: summed counts\nChanges: sum prices\nVerification: tests pass\nConfidence: high",
    });
    expect(await giveUp.next([START])).toMatchObject({
      done: "gave_up",
      reason: "needs a secret\nCategory: config\nNext step: add it",
    });
  });

  it("nudges once when the model answers without a tool, counting both calls", async () => {
    const { requests, next } = setup([
      answer({ content: "Let me think." }, 10),
      answer({ tool_calls: [call("list_files", { path: "." })] }, 20),
    ]);

    const result = await next([START]);

    expect(result).toMatchObject({
      toolCalls: [{ tool: "list_files", path: "." }],
      model: { inputTokens: 300, outputTokens: 30 },
    });
    expect(requests[1]?.messages.at(-1)?.content).toMatch(/calling exactly one of the tools/);
  });

  it("stops when the model still calls no tool, or calls one that doesn't exist", async () => {
    const silent = setup([answer({ content: "hmm" }), answer({ content: "still" })]);
    const wrong = setup([
      answer({ tool_calls: [call("shell", { command: "ls" })] }),
      answer({ tool_calls: [call("shell", { command: "ls" })] }),
    ]);

    expect(await silent.next([START])).toMatchObject({
      done: "stopped",
      reason: "the model didn't call a tool",
    });
    expect(await wrong.next([START])).toMatchObject({ done: "stopped" });
  });

  it("stops rather than send a conversation that doesn't fit the context", async () => {
    const huge = "z".repeat(200_000);
    const { requests, next } = setup([]);
    const write = stored("TOOL_CALL", 1, {
      callId: "c1",
      tool: "write_file",
      path: "a.ts",
      content: "x",
    });
    // Many results: once every output is a note and every argument is cut, it still won't fit.
    const results = Array.from({ length: 900 }, (_, i) =>
      stored("TOOL_RESULT", 2, { callId: `c${String(i)}`, ok: true, output: huge.slice(0, 10) }),
    );

    expect(await next([START, write, ...results], 2)).toMatchObject({
      done: "stopped",
      reason: "the conversation no longer fits the context",
    });
    expect(requests).toEqual([]);
  });

  it("keeps the first call's tokens when the nudged call fails", async () => {
    const { next } = setup([answer({ content: "thinking" }, 10)]);

    expect(await next([START])).toMatchObject({
      done: "stopped",
      reason: "the model call failed",
      model: { inputTokens: 100, outputTokens: 10 },
    });
  });

  it("throws when the first call fails, for the turns queue to record", async () => {
    const { next } = setup([]);

    await expect(next([START])).rejects.toThrow("no answer");
  });

  it("stops without a model call when the attempt is gone or a cap is reached", async () => {
    const gone = setup([], null);
    const capped = setup([]);
    const spent = stored("MODEL_CALL", 1, {
      model: "qwen3:14b",
      promptVersion: "heal-v1",
      inputTokens: policy.limits.maxModelTokensPerAttempt,
      outputTokens: 1,
      durationMs: 1,
    });

    expect(await gone.next([START])).toEqual({
      done: "stopped",
      reason: "the attempt's context is gone",
    });
    expect(await capped.next([START, spent])).toMatchObject({
      done: "stopped",
      reason: "model token cap reached",
    });
    expect(capped.requests).toEqual([]);
  });

  it("checks this step's edits, tells the model, and stops at the third breach of a rule", async () => {
    const edit = (stepSeq: number, callId: string) => [
      stored("TOOL_CALL", stepSeq - 1, {
        callId,
        tool: "write_file",
        path: ".github/workflows/x.yml",
        content: "on: push\n",
      }),
      stored("TOOL_RESULT", stepSeq, {
        callId,
        ok: true,
        output: DIFF(".github/workflows/x.yml"),
      }),
    ];
    // Earlier breaches of the same rule, on other paths: each one new.
    const breach = (stepSeq: number, callId: string) =>
      stored("POLICY_CHECK", stepSeq, {
        callId,
        violations: [
          { ruleId: "INV-GITHUB-DIR", message: "m", path: `.github/${String(stepSeq)}.yml` },
        ],
      });
    const once = setup([answer({ tool_calls: [call("list_files", { path: "." })] })]);
    const thrice = setup([]);

    const first = await once.next([START, ...edit(2, "c1")], 2);
    const third = await thrice.next(
      [
        START,
        ...edit(2, "c1"),
        breach(2, "c1"),
        ...edit(3, "c2"),
        breach(3, "c2"),
        ...edit(4, "c3"),
      ],
      4,
    );

    expect(first).toMatchObject({
      toolCalls: [{ tool: "list_files" }],
      policyChecks: [{ callId: "c1", violations: [{ ruleId: "INV-GITHUB-DIR" }] }],
    });
    expect(once.requests[0]?.messages.at(-1)?.content).toContain("<policy_feedback>");
    expect(third).toMatchObject({
      done: "stopped",
      reason: "the same rule was violated 3 times: INV-GITHUB-DIR",
      policyChecks: [{ callId: "c3" }],
    });
    expect(thrice.requests).toEqual([]);
  });
});

describe("checkEdits", () => {
  it("checks only this step's successful edit results with readable diffs", () => {
    const event = (
      type: TimelineEvent["type"],
      stepSeq: number,
      payload: unknown,
    ): TimelineEvent => ({ type, stepSeq, payload });
    const history: TimelineEvent[] = [
      event("TOOL_CALL", 1, {
        callId: "e1",
        tool: "apply_edit",
        path: "a.ts",
        oldStr: "a",
        newStr: "b",
      }),
      event("TOOL_CALL", 1, { callId: "r1", tool: "read_file", path: "a.ts" }),
      event("TOOL_CALL", 1, { callId: "e2", tool: "write_file", path: "b.ts", content: "" }),
      event("TOOL_CALL", 1, { callId: "e3", tool: "write_file", path: "c.ts", content: "" }),
      event("TOOL_RESULT", 2, { callId: "e1", ok: true, output: DIFF("src/new.ts") }),
      event("TOOL_RESULT", 2, { callId: "r1", ok: true, output: DIFF(".github/x") }),
      event("TOOL_RESULT", 2, { callId: "e2", ok: false, output: DIFF(".github/x") }),
      event("TOOL_RESULT", 2, { callId: "e3", ok: true, output: "diff --git a/x\n@@ nonsense" }),
      event("TOOL_RESULT", 1, { callId: "e1", ok: true, output: DIFF(".github/x") }),
      event("TOOL_RESULT", 2, "junk"),
    ];

    expect(checkEdits(history, 2, policy)).toEqual([{ callId: "e1", violations: [] }]);
  });
});
