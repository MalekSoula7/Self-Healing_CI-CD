// The healer's tools as the model sees them (SPEC §7.2), in Ollama's function-calling format, and
// the model's calls read back into the runner protocol's shape. Model output is untrusted: this
// only maps names and arguments; the protocol's schema validates every call on the server
// (apps/worker turns queue) before a runner sees it. submit_fix and give_up end the loop.
import { LIMITS } from "@pipeheal/shared/protocol";
import { z } from "zod";

interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, object>;
      required: string[];
    };
  };
}

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });

export const HEAL_TOOLS: readonly ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and directories under a repository path ('.' for the root).",
      parameters: {
        type: "object",
        properties: { path: str("Repository-relative directory"), depth: int("Levels, 1-10") },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file, optionally only lines start to end (1-based).",
      parameters: {
        type: "object",
        properties: {
          path: str("Repository-relative file path"),
          start: int("First line"),
          end: int("Last line"),
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_code",
      description: "Search the repository for a fixed string (git grep), optionally in a glob.",
      parameters: {
        type: "object",
        properties: { pattern: str("Text to find"), glob: str("Only paths matching this glob") },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_edit",
      description:
        "Replace old_str with new_str in a file. old_str must appear exactly once. Returns the cumulative diff.",
      parameters: {
        type: "object",
        properties: {
          path: str("Repository-relative file path"),
          old_str: str("Exact text to replace, unique in the file"),
          new_str: str("Replacement text"),
        },
        required: ["path", "old_str", "new_str"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create a file or replace its whole content. Returns the cumulative diff.",
      parameters: {
        type: "object",
        properties: { path: str("Repository-relative file path"), content: str("Full content") },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_check",
      description:
        "Run a configured check: install, build, lint, typecheck, test, or test_file with a target test file.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            enum: ["install", "build", "lint", "typecheck", "test", "test_file"],
          },
          target: str("For test_file: the test file to run"),
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_fix",
      description: "Finish: the fix is made and verified. The full checks run next.",
      parameters: {
        type: "object",
        properties: {
          root_cause: str("The root cause, 2-4 sentences"),
          changes: str("What you changed and why"),
          verification: str("How you verified it"),
          confidence: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["root_cause", "changes", "verification", "confidence"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "give_up",
      description: "Stop with a diagnosis when a code change isn't the right fix.",
      parameters: {
        type: "object",
        properties: {
          diagnosis: str("What is wrong, precisely"),
          category: {
            type: "string",
            enum: [
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
            ],
          },
          suggested_next_step: str("What a person should do"),
        },
        required: ["diagnosis", "category", "suggested_next_step"],
      },
    },
  },
];

/** Model-facing argument names that differ from the protocol's (SPEC §7.2 vs protocol.ts). */
const TO_PROTOCOL: Record<string, string> = { old_str: "oldStr", new_str: "newStr" };
export const FROM_PROTOCOL: Record<string, string> = { oldStr: "old_str", newStr: "new_str" };

const RUNNER_TOOLS = new Set([
  "list_files",
  "read_file",
  "search_code",
  "apply_edit",
  "write_file",
  "run_check",
]);

const text = z.string().trim().min(1).max(4_000);
const submitSchema = z.object({
  root_cause: text,
  changes: text,
  verification: text,
  confidence: z.enum(["low", "medium", "high"]),
});
const giveUpSchema = z.object({
  diagnosis: text,
  category: z.enum([
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
  ]),
  suggested_next_step: text,
});

const rawCallSchema = z.object({
  function: z.object({ name: z.string().min(1).max(64), arguments: z.unknown() }),
});

export type ToolCallsRead =
  /** Calls for the runner, in the protocol's shape without `callId` (still to be validated). */
  | { kind: "calls"; calls: Record<string, unknown>[] }
  | {
      kind: "submit";
      fix: {
        rootCause: string;
        changes: string;
        verification: string;
        confidence: "low" | "medium" | "high";
      };
    }
  | { kind: "give_up"; diagnosis: string; category: string; suggestedNextStep: string }
  | { kind: "none" }
  | { kind: "invalid"; reason: string };

function argumentsOf(raw: unknown): Record<string, unknown> | null {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Reads Ollama's `message.tool_calls`. */
export function readToolCalls(raw: unknown): ToolCallsRead {
  if (raw === undefined || raw === null) return { kind: "none" };
  const list = z.array(rawCallSchema).max(LIMITS.toolCallsPerStep).safeParse(raw);
  if (!list.success) return { kind: "invalid", reason: "tool calls the protocol can't read" };
  if (list.data.length === 0) return { kind: "none" };

  const calls: { name: string; args: Record<string, unknown> }[] = [];
  for (const call of list.data) {
    const args = argumentsOf(call.function.arguments);
    if (args === null) return { kind: "invalid", reason: "tool arguments that aren't an object" };
    calls.push({ name: call.function.name, args });
  }
  const ends = calls.filter((call) => call.name === "submit_fix" || call.name === "give_up");
  if (ends.length > 0) {
    const [end] = ends;
    if (calls.length > 1 || end === undefined) {
      return { kind: "invalid", reason: "submit_fix or give_up must be the only call" };
    }
    if (end.name === "submit_fix") {
      const fix = submitSchema.safeParse(end.args);
      if (!fix.success) return { kind: "invalid", reason: "a malformed submit_fix" };
      return {
        kind: "submit",
        fix: {
          rootCause: fix.data.root_cause,
          changes: fix.data.changes,
          verification: fix.data.verification,
          confidence: fix.data.confidence,
        },
      };
    }
    const giveUp = giveUpSchema.safeParse(end.args);
    if (!giveUp.success) return { kind: "invalid", reason: "a malformed give_up" };
    return {
      kind: "give_up",
      diagnosis: giveUp.data.diagnosis,
      category: giveUp.data.category,
      suggestedNextStep: giveUp.data.suggested_next_step,
    };
  }
  const unknown = calls.find((call) => !RUNNER_TOOLS.has(call.name));
  if (unknown !== undefined) return { kind: "invalid", reason: "a tool that doesn't exist" };
  return {
    kind: "calls",
    // `tool` last: an argument named "tool" can't change which tool runs.
    calls: calls.map(({ name, args }) => ({
      ...Object.fromEntries(
        Object.entries(args).map(([key, value]) => [TO_PROTOCOL[key] ?? key, value]),
      ),
      tool: name,
    })),
  };
}
