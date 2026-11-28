// Recorded Ollama /api/chat responses through msw: tests never run a real model (SPEC §6.2).
import { createLogger } from "@pipeheal/shared/logger";
import { mockServer } from "@pipeheal/shared/testing";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { ollamaClient } from "./ollama";
import { RULE_CONTEXT_TOKENS, ruleModel } from "./rule-model";

const OLLAMA = "http://ollama.test:11434";
const MODEL = "qwen3:14b";

function chat(content: string, doneReason = "stop") {
  return {
    model: MODEL,
    created_at: "2026-11-26T10:00:00.000Z",
    message: { role: "assistant", content },
    done: true,
    done_reason: doneReason,
    prompt_eval_count: 900,
    eval_count: 60,
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

const model = () =>
  ruleModel({
    client: ollamaClient({ baseUrl: OLLAMA }),
    model: MODEL,
    logger: createLogger({ level: "silent", service: "test" }),
  });

const compiled = {
  expressible: true,
  layer: { paths: { deny: ["src/payments/**"] } },
  explanation: "Denies the payments module.",
};

describe("ruleModel", () => {
  it("asks for a structured answer and returns it", async () => {
    const requests = serve(() => HttpResponse.json(chat(JSON.stringify(compiled))));

    await expect(model().compile("Never touch payments.")).resolves.toEqual(compiled);
    expect(requests[0]).toMatchObject({
      model: MODEL,
      think: false,
      options: { num_ctx: RULE_CONTEXT_TOKENS, temperature: 0 },
    });
    expect(JSON.stringify(requests[0])).toContain("<rule>");
  });

  it("retries once after an invalid answer, then gives up", async () => {
    const requests = serve(
      () => HttpResponse.json(chat("not json")),
      () =>
        HttpResponse.json(
          chat(JSON.stringify({ expressible: true, layer: null, explanation: "x" })),
        ),
    );

    await expect(model().compile("x")).resolves.toBeNull();
    expect(requests).toHaveLength(2);
  });

  it("treats a cut-off answer as invalid and an unreachable model as no answer", async () => {
    serve(
      () => HttpResponse.json(chat(JSON.stringify(compiled), "length")),
      () => HttpResponse.json({ error: "model not found" }, { status: 404 }),
    );

    await expect(model().compile("x")).resolves.toBeNull();
  });
});
