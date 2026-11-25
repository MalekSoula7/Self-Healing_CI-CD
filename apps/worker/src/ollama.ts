// A small client for Ollama, the self-hosted model server PipeHeal runs on (D11): `/api/chat`
// without streaming, and `/api/show` to check a model is pulled. Responses are validated with zod.
// Calls run one at a time: the model shares a single GPU, and Ollama would otherwise load extra
// copies or swap. Errors carry the status and Ollama's short message, never the prompt.
import { z } from "zod";

export interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  /** A JSON schema the answer must follow (Ollama's structured outputs). */
  format?: object;
  /** Reasoning models (qwen3) think first unless told not to. */
  think?: boolean;
  options?: { num_ctx?: number; num_predict?: number; temperature?: number };
}

const chatResponseSchema = z.object({
  model: z.string(),
  message: z.object({ role: z.string(), content: z.string() }),
  done: z.boolean(),
  /** "stop" when the answer is complete; "length" when it hit num_predict or the context. */
  done_reason: z.string().optional(),
  prompt_eval_count: z.int().nonnegative().optional(),
  eval_count: z.int().nonnegative().optional(),
});
export type OllamaChatResponse = z.infer<typeof chatResponseSchema>;

const errorBodySchema = z.object({ error: z.string() });

export class OllamaError extends Error {
  override readonly name = "OllamaError";

  constructor(
    /** HTTP status, or null when Ollama couldn't be reached or didn't answer in time. */
    readonly status: number | null,
    detail: string,
  ) {
    super(`Ollama ${status === null ? "" : `answered ${String(status)}: `}${detail}`);
  }
}

export interface OllamaClientOptions {
  /** e.g. http://localhost:11434 (OLLAMA_URL). */
  baseUrl: string;
  /** Per call; a local GPU is slower than an API. Default 180 s. */
  timeoutMs?: number;
}

export interface OllamaClient {
  chat(request: OllamaChatRequest): Promise<OllamaChatResponse>;
  /** Whether the model is pulled on the server. */
  hasModel(model: string): Promise<boolean>;
}

export function ollamaClient(options: OllamaClientOptions): OllamaClient {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const url = (path: string) => new URL(path, options.baseUrl).toString();

  async function post(path: string, body: object): Promise<Response> {
    try {
      return await fetch(url(path), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new OllamaError(null, timedOut ? "didn't answer in time" : "couldn't be reached");
    }
  }

  async function errorOf(response: Response): Promise<OllamaError> {
    const body = errorBodySchema.safeParse(await response.json().catch(() => null));
    return new OllamaError(response.status, body.success ? body.data.error.slice(0, 300) : "error");
  }

  // One call at a time: each waits for the previous one, whether it succeeded or not.
  let last: Promise<unknown> = Promise.resolve();
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = last.then(task, task);
    last = run.catch(() => undefined);
    return run;
  }

  return {
    chat(request) {
      return serialized(async () => {
        const response = await post("/api/chat", { ...request, stream: false });
        if (!response.ok) throw await errorOf(response);
        const parsed = chatResponseSchema.safeParse(await response.json().catch(() => null));
        if (!parsed.success) throw new OllamaError(response.status, "unexpected response");
        return parsed.data;
      });
    },
    async hasModel(model) {
      const response = await post("/api/show", { model });
      if (response.status === 404) return false;
      if (!response.ok) throw await errorOf(response);
      return true;
    },
  };
}
