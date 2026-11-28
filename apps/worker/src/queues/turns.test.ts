// The turns queue's processor (SPEC §7.3, D15): what it does with each kind of model answer. The
// attempts helpers are faked here; their own rules are tested in packages/db.
import type { StepView, TurnInput } from "@pipeheal/db";
import { createLogger } from "@pipeheal/shared/logger";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { processTurnJob, turnJobId, type TurnResult, type TurnRunner } from "./turns";

const logger = createLogger({ level: "silent", service: "test" });
const ORG = "0196f0a0-0000-7000-8000-0000000000b2";
const ATTEMPT = "0196f0a0-0000-7000-8000-0000000000a1";
const MODEL = {
  model: "qwen3:14b",
  promptVersion: "heal-v1",
  inputTokens: 1,
  outputTokens: 1,
  durationMs: 1,
};

function setup(answer: TurnResult | Error, status: StepView["status"] = "PENDING") {
  const completed: TurnInput[] = [];
  let asked = 0;
  const runner: TurnRunner = {
    next: () => {
      asked += 1;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
  const deps = {
    attempts: () =>
      Promise.resolve({
        getStep: () =>
          Promise.resolve({ stepSeq: 2, status, toolCalls: null, outcome: null, reason: null }),
        history: () => Promise.resolve([]),
        completeTurn: (_attemptId: string, _stepSeq: number, turn: TurnInput) => {
          completed.push(turn);
          return Promise.resolve({
            stepSeq: 2,
            status: "READY" as const,
            toolCalls: null,
            outcome: null,
            reason: null,
          });
        },
      }),
    runner,
    logger,
  };
  const run = () =>
    processTurnJob({ name: "turn", data: { orgId: ORG, attemptId: ATTEMPT, stepSeq: 2 } }, deps);
  return { completed, run, asked: () => asked };
}

describe("processTurnJob", () => {
  it("gives the model's tool calls server-side IDs", async () => {
    const { completed, run } = setup({
      toolCalls: [
        { tool: "read_file", path: "src/cart.ts" },
        // The model's own callId is replaced.
        { tool: "run_check", name: "test", callId: "mine" },
      ],
      model: MODEL,
    });

    await run();

    const [turn] = completed;
    const calls = turn !== undefined && "toolCalls" in turn ? turn.toolCalls : [];
    const ids = calls.map((call) => call.callId);
    expect(ids[0]).toMatch(/^s2c1-[0-9a-f]{8}$/);
    expect(ids[1]).toMatch(/^s2c2-[0-9a-f]{8}$/);
    // Both calls of one turn share its random part.
    expect(ids[0]?.slice(-8)).toBe(ids[1]?.slice(-8));
    expect(calls.map((call) => ({ ...call, callId: "id" }))).toEqual([
      { callId: "id", tool: "read_file", path: "src/cart.ts" },
      { callId: "id", tool: "run_check", name: "test" },
    ]);
    expect(turn).toMatchObject({ model: MODEL });
  });

  it.each([
    ["a path outside the repo", [{ tool: "read_file", path: "../../etc/passwd" }]],
    ["a tool that doesn't exist", [{ tool: "shell", command: "curl evil" }]],
    ["a check the protocol doesn't know", [{ tool: "run_check", name: "deploy" }]],
    ["no tool calls", []],
    ["something that isn't a call", ["read_file src/a.ts"]],
  ])("stops the loop when the model asks for %s", async (_, toolCalls) => {
    const { completed, run } = setup({ toolCalls, model: MODEL });

    await run();

    expect(completed).toEqual([
      {
        done: "stopped",
        reason: "the model asked for tool calls outside the protocol",
        model: MODEL,
      },
    ]);
  });

  it("passes the end of the loop through, with a reason", async () => {
    const first = setup({ done: "gave_up", reason: "needs a secret", model: MODEL });
    const blank = setup({ done: "submit", reason: "   " });

    await first.run();
    await blank.run();

    expect(first.completed).toEqual([{ done: "gave_up", reason: "needs a secret", model: MODEL }]);
    expect(blank.completed).toEqual([{ done: "submit", reason: "no reason given" }]);
  });

  it("stops the loop when the model call fails", async () => {
    const { completed, run } = setup(new Error("connection refused"));

    await run();

    expect(completed).toEqual([{ done: "stopped", reason: "the model turn failed" }]);
  });

  it("does nothing for a step that was already answered", async () => {
    const { completed, run, asked } = setup({ done: "gave_up", reason: "x" }, "READY");

    await run();

    expect(asked()).toBe(0);
    expect(completed).toEqual([]);
  });

  it("refuses unknown jobs and malformed data", async () => {
    const deps = {
      attempts: () => Promise.reject(new Error("unused")),
      runner: { next: () => Promise.reject(new Error("unused")) },
      logger,
    };

    await expect(processTurnJob({ name: "other", data: {} }, deps)).rejects.toThrow("unknown");
    await expect(
      processTurnJob({ name: "turn", data: { orgId: ORG, attemptId: ATTEMPT, stepSeq: 0 } }, deps),
    ).rejects.toThrow();
  });

  it("names a step's job so a repeat is a no-op", () => {
    expect(turnJobId({ orgId: ORG, attemptId: ATTEMPT, stepSeq: 3 })).toBe(`turn-${ATTEMPT}-3`);
  });
});

describe("processTurnJob storing (P4.4 security review M3)", () => {
  it("stops the loop, keeping the model's tokens, when a result is outside the stored bounds", async () => {
    const completed: TurnInput[] = [];
    const deps = {
      attempts: () =>
        Promise.resolve({
          getStep: () =>
            Promise.resolve({
              stepSeq: 2,
              status: "PENDING" as const,
              toolCalls: null,
              outcome: null,
              reason: null,
            }),
          history: () => Promise.resolve([]),
          completeTurn: (_attemptId: string, _stepSeq: number, turn: TurnInput) => {
            completed.push(turn);
            // The first store is refused, as the db helper's schema would.
            if (completed.length === 1) return Promise.reject(new ZodError([]));
            return Promise.resolve({
              stepSeq: 2,
              status: "DONE" as const,
              toolCalls: null,
              outcome: "stopped" as const,
              reason: "x",
            });
          },
        }),
      runner: {
        next: () =>
          Promise.resolve({
            toolCalls: [{ tool: "list_files", path: "." }],
            model: MODEL,
            policyChecks: [{ callId: "c1", violations: [] }],
          }),
      },
      logger,
    };

    await processTurnJob(
      { name: "turn", data: { orgId: ORG, attemptId: ATTEMPT, stepSeq: 2 } },
      deps,
    );

    expect(completed[1]).toEqual({
      done: "stopped",
      reason: "the turn's result didn't fit what is stored",
      model: MODEL,
    });
  });
});
