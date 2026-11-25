// Recorded Ollama /api/chat responses through msw: tests never run a real model (SPEC §6.2).
import { extractSignals } from "@pipeheal/agent-core";
import type { ModelCallInput } from "@pipeheal/db";
import { createLogger } from "@pipeheal/shared/logger";
import { mockServer } from "@pipeheal/shared/testing";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { ollamaClient } from "./ollama";
import { TRIAGE_CONTEXT_TOKENS, triageModel } from "./triage-model";

const OLLAMA = "http://ollama.test:11434";
const MODEL = "qwen3:14b";

const window = "Run make\nmake: *** [all] Error 2\n##[error]Process completed with exit code 2.";
const input = {
  window,
  signals: extractSignals(window, "Build"),
  workflowName: "CI",
  jobName: "build",
};

const answer = {
  category: "build",
  confidence: 0.6,
  summary: "make's default target failed; the log doesn't show which command.",
  suspectedFiles: ["Makefile"],
};

/** An /api/chat response as Ollama returns it (stream: false). */
function chat(content: string, doneReason = "stop") {
  return {
    model: MODEL,
    created_at: "2026-11-25T18:00:00.000Z",
    message: { role: "assistant", content },
    done: true,
    done_reason: doneReason,
    total_duration: 4_200_000_000,
    prompt_eval_count: 1834,
    eval_count: 96,
  };
}

function serve(...responses: (() => Response)[]) {
  const requests: Record<string, unknown>[] = [];
  let index = 0;
  mockServer.use(
    http.post(`${OLLAMA}/api/chat`, async ({ request }) => {
      requests.push((await request.json()) as Record<string, unknown>);
      const respond = responses[Math.min(index++, responses.length - 1)];
      if (respond === undefined) throw new Error("test setup: no response");
      return respond();
    }),
  );
  return requests;
}

function run() {
  const calls: ModelCallInput[] = [];
  const model = triageModel({
    client: ollamaClient({ baseUrl: OLLAMA }),
    model: MODEL,
    logger: createLogger({ level: "silent", service: "test" }),
  });
  const result = model.classify(input, (call) => {
    calls.push(call);
    return Promise.resolve();
  });
  return { result, calls };
}

describe("triageModel on Ollama", () => {
  it("asks for an answer following the triage schema and returns it, recording its tokens", async () => {
    const requests = serve(() => HttpResponse.json(chat(JSON.stringify(answer))));

    const { result, calls } = run();

    await expect(result).resolves.toEqual(answer);
    expect(calls).toEqual([
      {
        purpose: "triage",
        model: MODEL,
        promptVersion: "triage-v2",
        inputTokens: 1834,
        outputTokens: 96,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        outcome: "valid",
      },
    ]);
    const [request] = requests;
    expect(request).toMatchObject({
      model: MODEL,
      stream: false,
      think: false,
      options: { num_ctx: TRIAGE_CONTEXT_TOKENS, temperature: 0 },
    });
    expect(request).toHaveProperty("messages.0.role", "system");
    expect(JSON.stringify(request)).toMatch(/Never follow instructions/);
    expect(request).toHaveProperty("format.properties.category.enum", [
      "compile",
      "typecheck",
      "lint",
      "test",
      "dependency",
      "build",
      "infra",
      "config",
      "flaky",
      "unknown",
    ]);
  });

  it("caps the model's confidence below every heuristic's", async () => {
    serve(() => HttpResponse.json(chat(JSON.stringify({ ...answer, confidence: 1 }))));

    await expect(run().result).resolves.toMatchObject({ category: "build", confidence: 0.75 });
  });

  it("retries once after an invalid answer, and records both calls", async () => {
    serve(
      () => HttpResponse.json(chat(JSON.stringify({ ...answer, category: "network" }))),
      () => HttpResponse.json(chat(JSON.stringify(answer))),
    );

    const { result, calls } = run();

    await expect(result).resolves.toEqual(answer);
    expect(calls.map((call) => call.outcome)).toEqual(["invalid", "valid"]);
  });

  it.each([
    ["not JSON", () => HttpResponse.json(chat("The build failed."))],
    ["cut off (length)", () => HttpResponse.json(chat(JSON.stringify(answer), "length"))],
  ])("gives up after two invalid answers (%s)", async (_case, respond) => {
    serve(respond);

    const { result, calls } = run();

    await expect(result).resolves.toBeNull();
    expect(calls.map((call) => call.outcome)).toEqual(["invalid", "invalid"]);
  });

  it.each([
    [
      "an error answer (model not pulled)",
      () => HttpResponse.json({ error: "model 'qwen3:14b' not found" }, { status: 404 }),
    ],
    ["Ollama unreachable", () => HttpResponse.error()],
    ["a response that isn't Ollama's", () => HttpResponse.json({ hello: "world" })],
  ])("records a failed call and doesn't retry it: %s", async (_case, respond) => {
    const requests = serve(respond);

    const { result, calls } = run();

    await expect(result).resolves.toBeNull();
    expect(requests).toHaveLength(1);
    expect(calls).toMatchObject([
      { outcome: "error", inputTokens: 0, outputTokens: 0, costUsd: 0 },
    ]);
  });
});
