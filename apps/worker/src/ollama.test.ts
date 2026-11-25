import { mockServer } from "@pipeheal/shared/testing";
import { delay, http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { OllamaError, ollamaClient } from "./ollama";

const OLLAMA = "http://ollama.test:11434";

function chat(content: string) {
  return {
    model: "qwen3:14b",
    message: { role: "assistant", content },
    done: true,
    done_reason: "stop",
  };
}

const request = { model: "qwen3:14b", messages: [{ role: "user" as const, content: "hi" }] };

describe("ollamaClient", () => {
  it("runs one call at a time: the GPU is shared", async () => {
    let running = 0;
    let most = 0;
    mockServer.use(
      http.post(`${OLLAMA}/api/chat`, async () => {
        running += 1;
        most = Math.max(most, running);
        await delay(30);
        running -= 1;
        return HttpResponse.json(chat("ok"));
      }),
    );
    const client = ollamaClient({ baseUrl: OLLAMA });

    await Promise.all([client.chat(request), client.chat(request), client.chat(request)]);

    expect(most).toBe(1);
  });

  it("keeps going after a failed call", async () => {
    let calls = 0;
    mockServer.use(
      http.post(`${OLLAMA}/api/chat`, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ error: "busy" }, { status: 503 })
          : HttpResponse.json(chat("ok"));
      }),
    );
    const client = ollamaClient({ baseUrl: OLLAMA });

    await expect(client.chat(request)).rejects.toThrow(OllamaError);
    await expect(client.chat(request)).resolves.toMatchObject({ message: { content: "ok" } });
  });

  it("reports Ollama's error message and status, never the prompt", async () => {
    mockServer.use(
      http.post(`${OLLAMA}/api/chat`, () =>
        HttpResponse.json({ error: "model 'qwen3:14b' not found" }, { status: 404 }),
      ),
    );

    const error: unknown = await ollamaClient({ baseUrl: OLLAMA })
      .chat({ ...request, messages: [{ role: "user", content: "secret prompt text" }] })
      .then(
        () => null,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(OllamaError);
    expect(error).toMatchObject({ status: 404 });
    expect(String(error)).toContain("not found");
    expect(String(error)).not.toContain("secret prompt text");
  });

  it("gives up on a call that takes too long", async () => {
    mockServer.use(
      http.post(`${OLLAMA}/api/chat`, async () => {
        await delay(2_000);
        return HttpResponse.json(chat("late"));
      }),
    );

    await expect(ollamaClient({ baseUrl: OLLAMA, timeoutMs: 50 }).chat(request)).rejects.toThrow(
      /didn't answer in time/,
    );
  });

  it("tells whether a model is pulled", async () => {
    mockServer.use(
      http.post(`${OLLAMA}/api/show`, async ({ request: show }) => {
        const { model } = (await show.json()) as { model: string };
        return model === "qwen3:14b"
          ? HttpResponse.json({ details: { family: "qwen3" } })
          : HttpResponse.json({ error: "not found" }, { status: 404 });
      }),
    );
    const client = ollamaClient({ baseUrl: OLLAMA });

    await expect(client.hasModel("qwen3:14b")).resolves.toBe(true);
    await expect(client.hasModel("llama3:70b")).resolves.toBe(false);
  });
});
