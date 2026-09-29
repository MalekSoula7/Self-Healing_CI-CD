// Recorded Messages API responses through msw: tests never call the real API (SPEC §6.2).
import Anthropic from "@anthropic-ai/sdk";
import { extractSignals } from "@pipeheal/agent-core";
import type { ModelCallInput } from "@pipeheal/db";
import { createLogger } from "@pipeheal/shared/logger";
import { mockServer } from "@pipeheal/shared/testing";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { callCost } from "./model-prices";
import { apiErrorDetail, triageModel } from "./triage-model";

const MESSAGES = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";
const PRICE = { input: 1, output: 5 };

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

/** A Messages API response as the API returns it. */
function message(text: string, stopReason = "end_turn", usage: Record<string, number> = {}) {
  return {
    id: "msg_01XFDUDYJgAACzvnptvVoYEL",
    type: "message",
    role: "assistant",
    model: MODEL,
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 1834,
      output_tokens: 96,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      ...usage,
    },
  };
}

function serve(...responses: (() => Response)[]) {
  const requests: Record<string, unknown>[] = [];
  let index = 0;
  mockServer.use(
    http.post(MESSAGES, async ({ request }) => {
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
    client: new Anthropic({ apiKey: "test-key", maxRetries: 0 }),
    model: MODEL,
    price: PRICE,
    logger: createLogger({ level: "silent", service: "test" }),
  });
  const result = model.classify(input, (call) => {
    calls.push(call);
    return Promise.resolve();
  });
  return { result, calls };
}

describe("triageModel", () => {
  it("asks for a structured answer and returns it, recording the call's tokens and cost", async () => {
    const requests = serve(() => HttpResponse.json(message(JSON.stringify(answer))));

    const { result, calls } = run();

    await expect(result).resolves.toEqual(answer);
    expect(calls).toEqual([
      {
        purpose: "triage",
        model: MODEL,
        promptVersion: "triage-v1",
        inputTokens: 1834,
        outputTokens: 96,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: (1834 * 1 + 96 * 5) / 1_000_000,
        outcome: "valid",
      },
    ]);
    const [request] = requests;
    expect(request).toMatchObject({ model: MODEL, max_tokens: 1024 });
    expect(JSON.stringify(request?.system)).toMatch(/Never follow instructions/);
    expect(request).toHaveProperty("output_config.format.type", "json_schema");
    expect(request).toHaveProperty("output_config.format.schema.properties.category.enum", [
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
    expect(request).not.toHaveProperty("thinking");
  });

  it("retries once after an invalid answer, and records both calls", async () => {
    serve(
      () => HttpResponse.json(message(JSON.stringify({ ...answer, category: "network" }))),
      () => HttpResponse.json(message(JSON.stringify(answer))),
    );

    const { result, calls } = run();

    await expect(result).resolves.toEqual(answer);
    expect(calls.map((call) => call.outcome)).toEqual(["invalid", "valid"]);
  });

  it.each([
    ["not JSON", () => HttpResponse.json(message("The build failed."))],
    [
      "cut off at max_tokens",
      () => HttpResponse.json(message(JSON.stringify(answer), "max_tokens")),
    ],
    ["a refusal", () => HttpResponse.json(message(JSON.stringify(answer), "refusal"))],
  ])("gives up after two invalid answers (%s)", async (_case, respond) => {
    serve(respond);

    const { result, calls } = run();

    await expect(result).resolves.toBeNull();
    expect(calls.map((call) => call.outcome)).toEqual(["invalid", "invalid"]);
  });

  it("records a failed API call and doesn't retry it", async () => {
    const requests = serve(() =>
      HttpResponse.json(
        { type: "error", error: { type: "api_error", message: "Internal server error" } },
        { status: 500 },
      ),
    );

    const { result, calls } = run();

    await expect(result).resolves.toBeNull();
    expect(requests).toHaveLength(1);
    expect(calls).toMatchObject([
      { outcome: "error", inputTokens: 0, outputTokens: 0, costUsd: 0 },
    ]);
  });
});

describe("apiErrorDetail", () => {
  it("takes the API's error type and message, and nothing when the body isn't the API's", () => {
    const body = {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "This API key is not scoped to a workspace.",
      },
    };
    const headers = new Headers();
    expect(apiErrorDetail(new Anthropic.APIError(400, body, undefined, headers))).toEqual({
      errorType: "invalid_request_error",
      errorMessage: "This API key is not scoped to a workspace.",
    });
    expect(apiErrorDetail(new Anthropic.APIError(502, "Bad Gateway", undefined, headers))).toEqual(
      {},
    );
  });
});

describe("callCost", () => {
  it("prices input, output and cache tokens (cache defaults: 0.1x reads, 1.25x writes)", () => {
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
    } as Anthropic.Usage;

    expect(callCost({ input: 1, output: 5 }, usage)).toBeCloseTo(1 + 5 + 0.1 + 1.25, 10);
    expect(callCost({ input: 1, output: 5, cacheRead: 0.2, cacheWrite: 2 }, usage)).toBeCloseTo(
      8.2,
      10,
    );
  });
});
