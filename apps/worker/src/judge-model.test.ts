// Recorded Ollama /api/chat responses through msw: tests never run a real model (SPEC §6.2).
import {
  JUDGE_CONTEXT_TOKENS,
  MAX_JUDGE_DIFF_TOKENS,
  judgeDecision,
  type JudgeRule,
} from "@pipeheal/agent-core";
import { buildChange, effectivePolicy, type PolicyLayer } from "@pipeheal/policy";
import { createLogger } from "@pipeheal/shared/logger";
import { mockServer } from "@pipeheal/shared/testing";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { judgeModel, judgeSubmission, type JudgeModel } from "./judge-model";
import { ollamaClient } from "./ollama";

const OLLAMA = "http://ollama.test:11434";
const MODEL = "qwen3:14b";
const DIFF = "--- a/src/sum.ts\n+++ b/src/sum.ts\n@@ -1,1 +1,1 @@\n-a - b\n+a + b\n";
const LATER = { deadline: Number.MAX_SAFE_INTEGER };
const logger = createLogger({ level: "silent", service: "test" });

const api: JudgeRule = { id: "CR-2", layer: "org-default", text: "Keep the public API." };
const small: JudgeRule = { id: "CR-1", layer: "repo-file", text: "Keep functions short." };

function chat(content: string, doneReason = "stop", promptTokens: number | null = 700) {
  return {
    model: MODEL,
    created_at: "2026-11-27T10:00:00.000Z",
    message: { role: "assistant", content },
    done: true,
    done_reason: doneReason,
    ...(promptTokens === null ? {} : { prompt_eval_count: promptTokens }),
    eval_count: 40,
  };
}

const answer = (violated: boolean) =>
  HttpResponse.json(chat(JSON.stringify({ reasoning: "Only the body changed.", violated })));

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

const model = (now?: () => number) =>
  judgeModel({ client: ollamaClient({ baseUrl: OLLAMA }), model: MODEL, logger, now });

describe("judgeModel", () => {
  it("judges each rule in its own structured call, and records every call", async () => {
    const requests = serve(
      () => answer(false),
      () => answer(true),
    );

    const report = await model().judge([api, small], DIFF, LATER);

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      model: MODEL,
      think: false,
      format: { required: ["reasoning", "violated"] },
      options: { num_ctx: JUDGE_CONTEXT_TOKENS, temperature: 0 },
    });
    expect(JSON.stringify(requests[0])).toContain("[CR-2] Keep the public API.");
    expect(JSON.stringify(requests[1])).toContain("[CR-1] Keep functions short.");
    expect(report).toMatchObject({ model: MODEL, promptVersion: "judge-v1" });
    expect(report.outcomes).toEqual([
      {
        kind: "verdict",
        ruleId: "CR-2",
        layer: "org-default",
        violated: false,
        reasoning: "Only the body changed.",
      },
      {
        kind: "verdict",
        ruleId: "CR-1",
        layer: "repo-file",
        violated: true,
        reasoning: "Only the body changed.",
      },
    ]);
    expect(report.calls).toEqual([
      { ruleId: "CR-2", layer: "org-default", inputTokens: 700, outputTokens: 40, valid: true },
      { ruleId: "CR-1", layer: "repo-file", inputTokens: 700, outputTokens: 40, valid: true },
    ]);
    expect(judgeDecision([api, small], report.outcomes).passed).toBe(false);
  });

  it("refuses an answer that names its own rule: the schema has no room for one", async () => {
    serve(() =>
      HttpResponse.json(
        chat(JSON.stringify({ reasoning: "Fine.", violated: false, ruleId: "CR-9" })),
      ),
    );

    const report = await model().judge([api], DIFF, LATER);

    expect(report.outcomes).toEqual([
      {
        kind: "unjudged",
        ruleId: "CR-2",
        layer: "org-default",
        reason: "the model gave no valid answer",
      },
    ]);
    expect(report.calls.map((call) => call.valid)).toEqual([false, false]);
  });

  it("retries once, warmer, after an invalid or cut-off answer", async () => {
    const requests = serve(
      () => HttpResponse.json(chat("not json")),
      () => answer(false),
      () => HttpResponse.json(chat(JSON.stringify({ reasoning: "x", violated: false }), "length")),
      () => HttpResponse.json(chat("{}")),
    );

    const report = await model().judge([api, small], DIFF, LATER);

    expect(requests).toHaveLength(4);
    expect(requests[1]).toMatchObject({ options: { temperature: 0.3 } });
    expect(report.outcomes.map((outcome) => outcome.kind)).toEqual(["verdict", "unjudged"]);
  });

  it("leaves a rule unjudged when the model can't be reached, records the call, and goes on", async () => {
    serve(
      () => HttpResponse.json({ error: "model not found" }, { status: 404 }),
      () => answer(false),
    );

    const report = await model().judge([api, small], DIFF, LATER);

    expect(report.outcomes[0]).toEqual({
      kind: "unjudged",
      ruleId: "CR-2",
      layer: "org-default",
      reason: "the model couldn't be reached",
    });
    expect(report.outcomes[1]).toMatchObject({ kind: "verdict", ruleId: "CR-1", violated: false });
    expect(report.calls[0]).toEqual({
      ruleId: "CR-2",
      layer: "org-default",
      inputTokens: 0,
      outputTokens: 0,
      valid: false,
    });
  });

  it("refuses an answer to a prompt that may have overflowed the context", async () => {
    const valid = JSON.stringify({ reasoning: "Fine.", violated: false });
    const requests = serve(
      () => HttpResponse.json(chat(valid, "stop", JUDGE_CONTEXT_TOKENS - 100)),
      () => HttpResponse.json(chat(valid, "stop", null)),
    );

    const report = await model().judge([api, small], DIFF, LATER);

    // No retry: the same prompt would overflow again.
    expect(requests).toHaveLength(2);
    expect(report.outcomes.map((o) => o.kind === "unjudged" && o.reason)).toEqual([
      "the change didn't fit the model's context",
      "the change didn't fit the model's context",
    ]);
  });

  it("stops calling the model at the deadline", async () => {
    const requests = serve(() => answer(false));
    let clock = 0;

    const report = await model(() => clock++).judge([api, small], DIFF, { deadline: 1 });

    expect(requests).toHaveLength(1);
    expect(report.outcomes[1]).toMatchObject({
      kind: "unjudged",
      reason: "the judge ran out of time",
    });
  });

  it("makes no call without rules", async () => {
    const requests = serve(() => answer(true));

    await expect(model().judge([], DIFF, LATER)).resolves.toMatchObject({
      outcomes: [],
      calls: [],
    });
    expect(requests).toHaveLength(0);
  });
});

describe("judgeSubmission", () => {
  const text = (content: string) => ({ kind: "text" as const, content, mode: "100644" as const });
  const changes = [buildChange({ path: "src/sum.ts", old: text("a - b"), new: text("a + b") })];
  const policyWith = (layers: { orgDefaults?: PolicyLayer; repoFile?: PolicyLayer }) =>
    effectivePolicy(layers).policy;
  const judgeRule = (id: string, text: string) => ({ id, text, enforcement: "judge" as const });
  const run = (
    policy: ReturnType<typeof policyWith>,
    judge: JudgeModel = model(),
    input = changes,
  ) =>
    judgeSubmission(judge, { policy, changes: input, deadline: Number.MAX_SAFE_INTEGER }, logger);

  it("passes without a model call when there are no judge rules", async () => {
    const requests = serve(() => answer(true));

    const result = await run(policyWith({}));

    expect(result.decision.passed).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("judges every judge rule against the server's own diff", async () => {
    const requests = serve(() => answer(false));

    const result = await run(
      policyWith({ orgDefaults: { customRules: [judgeRule("CR-1", "Keep the API.")] } }),
    );

    expect(result.decision.passed).toBe(true);
    expect(JSON.stringify(requests[0])).toContain("+a + b");
  });

  it("fails rules past the cap, without calling the model for them", async () => {
    const requests = serve(() => answer(false));
    const many = Array.from({ length: 7 }, (_, index) => judgeRule(`CR-${String(index + 1)}`, "x"));

    const result = await run(policyWith({ repoFile: { customRules: many } }));

    expect(requests).toHaveLength(5);
    expect(result.decision.passed).toBe(false);
    expect(result.decision.unjudged.map((u) => u.reason)).toEqual([
      "past the judge's rule cap",
      "past the judge's rule cap",
    ]);
  });

  it("fails every rule when the change is too large to read whole", async () => {
    const requests = serve(() => answer(false));
    const big = [
      buildChange({
        path: "big.ts",
        old: { kind: "absent" },
        new: text("漢".repeat(MAX_JUDGE_DIFF_TOKENS)),
      }),
    ];

    const result = await run(
      policyWith({ orgDefaults: { customRules: [judgeRule("CR-1", "x")] } }),
      model(),
      big,
    );

    expect(requests).toHaveLength(0);
    expect(result.decision).toMatchObject({
      passed: false,
      unjudged: [{ reason: "the change is too large for the judge to read whole" }],
    });
  });

  it("fails every rule when the judge throws", async () => {
    const broken: JudgeModel = {
      judge: () => Promise.reject(new Error("bug")),
    };

    const result = await run(
      policyWith({ orgDefaults: { customRules: [judgeRule("CR-1", "x")] } }),
      broken,
    );

    expect(result.decision).toMatchObject({
      passed: false,
      unjudged: [{ ruleId: "CR-1", reason: "the judge failed" }],
    });
  });
});
