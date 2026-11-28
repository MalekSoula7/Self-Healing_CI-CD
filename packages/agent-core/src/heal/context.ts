// The healer's conversation (SPEC §7.1, §7.3): the failure as the model first sees it, then the
// loop replayed from the attempt's timeline, fitted into the context window (D17). Everything
// from the repository, the runner or an earlier model turn is untrusted: it is wrapped, with chat
// markers and prompt tags broken up (./untrusted), and each part of the brief has a fixed share
// of the budget. Server feedback has its own tag that untrusted text can't produce. Also: the
// loop's stop conditions, and the fast policy check on every edit's cumulative diff (§7.2).
import {
  buildChange,
  checkChanges,
  parseUnifiedDiff,
  type EffectivePolicy,
} from "@pipeheal/policy";
import { toolCallSchema } from "@pipeheal/shared/protocol";
import { z } from "zod";
import { estimateTokens } from "../changes";
import { FROM_PROTOCOL } from "./tools";
import { neutralizeUntrusted, oneLineUntrusted } from "./untrusted";

/** What the server knows about the failure (SPEC §7.1), redacted already. */
export interface HealBrief {
  repo: { fullName: string; defaultBranch: string; language: string | null };
  commands: Partial<Record<string, string[]>>;
  failingCheck: string;
  failure: { category: string | null; summary: string | null; headBranch: string | null };
  jobs: {
    name: string;
    failedStep: string | null;
    summary: string | null;
    errorWindow: string | null;
  }[];
  /** `renderRecentChanges` output, or null when unknown. */
  recentChanges: string | null;
  /** A retry: the checkout holds an earlier fix, and `jobs` are what CI said about it. */
  previousFix?: boolean;
}

/** An AgentEvent as stored: its payload is whatever was written, read with care. */
export interface TimelineEvent {
  type: "MODEL_CALL" | "TOOL_CALL" | "TOOL_RESULT" | "POLICY_CHECK" | "INFO";
  stepSeq: number;
  payload: unknown;
}

export interface HealMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

/** Each part of the brief keeps to its share of the prompt, in characters (review H3). */
export const BRIEF_SHARES = {
  ciLogs: 8_000,
  recentChanges: 6_000,
  reproduction: 3_000,
  fileTreeEntries: 300,
  fileTree: 4_000,
  triageSummary: 600,
  /** The model's own earlier words, replayed (review L1). */
  modelText: 2_000,
  /** One policy violation's detail (review M2). */
  feedbackDetail: 200,
} as const;

const startSchema = z.object({
  kind: z.literal("start"),
  check: z.object({ name: z.string(), exitCode: z.int().nullable(), output: z.string() }),
  fileTree: z.array(z.string()),
});
const modelSchema = z.object({
  inputTokens: z.int().min(0),
  outputTokens: z.int().min(0),
  text: z.string().optional(),
});
const resultSchema = z.object({ callId: z.string(), ok: z.boolean(), output: z.string() });
const policySchema = z.object({
  callId: z.string(),
  violations: z.array(
    z.object({ ruleId: z.string(), message: z.string(), path: z.string().nullable().optional() }),
  ),
});

/** The end of `text` within `max` characters, saying how much was cut. */
function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `[${String(text.length - max)} earlier characters omitted]\n${text.slice(-max)}`;
}

/** The start of `text` within `max` characters, saying how much was cut. */
function head(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[${String(text.length - max)} more characters omitted]`;
}

/** `body` inside `<tag ...>`, as untrusted data. Attribute values are sanitized too. */
function wrap(tag: string, attributes: Record<string, string>, body: string): string {
  const attrs = Object.entries(attributes)
    .map(([key, value]) => ` ${key}="${oneLineUntrusted(value.replace(/["<>]/g, " "), 120)}"`)
    .join("");
  return `<${tag}${attrs}>\n${neutralizeUntrusted(body)}\n</${tag}>`;
}

function briefMessage(
  brief: HealBrief,
  start: z.infer<typeof startSchema> | null,
  repoRules: readonly string[],
): string {
  const { repo, failure } = brief;
  const line = (text: string) => oneLineUntrusted(text, 300);
  const lines = [
    `Repository: ${line(repo.fullName)} (default branch ${line(repo.defaultBranch)}${repo.language === null ? "" : `, ${line(repo.language)}`})`,
    `Failing check: ${line(brief.failingCheck)}`,
    "Configured commands:",
    ...Object.entries(brief.commands).map(
      ([name, argv]) => `- ${line(name)}: ${line((argv ?? []).join(" "))}`,
    ),
  ];
  if (failure.headBranch !== null) lines.push(`Failing branch: ${line(failure.headBranch)}`);
  if (failure.category !== null) lines.push(`Triage category: ${line(failure.category)}`);
  if (brief.previousFix === true) {
    lines.push(
      "A previous fix is already committed in this checkout, but CI still failed. The CI logs below are from that run: fix what is still broken.",
    );
  }
  const parts = [lines.join("\n")];
  if (failure.summary !== null) {
    parts.push(wrap("triage_summary", {}, head(failure.summary, BRIEF_SHARES.triageSummary)));
  }
  const logs = brief.jobs.filter((job) => job.errorWindow !== null && job.errorWindow !== "");
  if (logs.length === 0) parts.push("(no CI log)");
  // The CI logs share one budget, each job getting an equal part of it (the end of its window).
  const perLog = Math.floor(BRIEF_SHARES.ciLogs / Math.max(1, logs.length));
  for (const job of logs) {
    const body = [job.summary ?? "", tail(job.errorWindow ?? "", perLog)].filter(
      (part) => part !== "",
    );
    parts.push(
      wrap(
        "ci_log",
        { job: job.name, ...(job.failedStep === null ? {} : { step: job.failedStep }) },
        body.join("\n\n"),
      ),
    );
  }
  if (brief.recentChanges !== null) {
    parts.push(wrap("recent_changes", {}, head(brief.recentChanges, BRIEF_SHARES.recentChanges)));
  }
  if (repoRules.length > 0) parts.push(wrap("repo_rules", {}, repoRules.join("\n")));
  if (start !== null) {
    parts.push(
      wrap(
        "reproduction",
        { exit_code: start.check.exitCode === null ? "none" : String(start.check.exitCode) },
        tail(start.check.output, BRIEF_SHARES.reproduction),
      ),
    );
    const shown = start.fileTree.slice(0, BRIEF_SHARES.fileTreeEntries).join("\n");
    const more = start.fileTree.length - BRIEF_SHARES.fileTreeEntries;
    parts.push(
      wrap(
        "file_tree",
        {},
        head(shown, BRIEF_SHARES.fileTree) +
          (more > 0 ? `\n[${String(more)} more paths: use list_files]` : ""),
      ),
    );
  }
  return parts.join("\n\n");
}

interface ToolParts {
  callId: string;
  ok: boolean;
  output: string;
  feedback: string;
}

function toolContent(parts: ToolParts, omitted = false): string {
  const body = omitted
    ? `[output omitted to fit the context: ${String(parts.output.length)} characters. Call the tool again if you need it.]`
    : parts.output;
  return wrap("tool_output", { call: parts.callId, ok: String(parts.ok) }, body) + parts.feedback;
}

/** Server feedback: its own tag, which neutralized untrusted text can never produce. */
function feedback(violations: z.infer<typeof policySchema>["violations"]): string {
  const lines = violations.map((violation) => {
    const detail = oneLineUntrusted(violation.message, BRIEF_SHARES.feedbackDetail);
    return `[${oneLineUntrusted(violation.ruleId, 100)}] ${detail}`;
  });
  return `\n<policy_feedback>\nThe changes so far break these rules. Undo or change them:\n${lines.join("\n")}\n</policy_feedback>`;
}

function size(message: HealMessage): number {
  // A few tokens of framing per message, plus the calls' arguments.
  return (
    4 +
    estimateTokens(message.content) +
    (message.tool_calls === undefined ? 0 : estimateTokens(JSON.stringify(message.tool_calls)))
  );
}

/** A replayed call with its long arguments (file content, edit strings) cut down. */
function shortened(
  call: NonNullable<HealMessage["tool_calls"]>[number],
): NonNullable<HealMessage["tool_calls"]>[number] {
  const args = Object.fromEntries(
    Object.entries(call.function.arguments).map(([key, value]) =>
      typeof value === "string" && value.length > 200
        ? [key, `[${String(value.length)} characters omitted]`]
        : [key, value],
    ),
  );
  return { function: { name: call.function.name, arguments: args } };
}

export interface HealMessagesInput {
  systemPrompt: string;
  brief: HealBrief;
  history: readonly TimelineEvent[];
  /** Tokens the prompt may take: the context window minus room for the answer. */
  tokenBudget: number;
  /** `healRuleLines(policy).repoFile`: shown as untrusted data. */
  repoRules?: readonly string[];
}

export function buildHealMessages(input: HealMessagesInput): {
  messages: HealMessage[];
  estimatedTokens: number;
  /** Still over the budget after every cut: the caller must not send it (review H3). */
  overBudget: boolean;
} {
  let start: z.infer<typeof startSchema> | null = null;
  for (const event of input.history) {
    const parsed = event.type === "INFO" ? startSchema.safeParse(event.payload) : null;
    if (parsed?.success === true) start = parsed.data;
  }
  const messages: HealMessage[] = [
    { role: "system", content: input.systemPrompt },
    { role: "user", content: briefMessage(input.brief, start, input.repoRules ?? []) },
  ];

  const toolNames = new Map<string, string>();
  const toolParts = new Map<HealMessage, ToolParts>();
  const byCall = new Map<string, HealMessage>();
  const assistants: HealMessage[] = [];
  let assistant: HealMessage | null = null;

  for (const event of input.history) {
    if (event.type === "MODEL_CALL") {
      const model = modelSchema.safeParse(event.payload);
      if (!model.success) continue;
      // The model's own words can repeat injected text: replayed short and neutralized.
      assistant = {
        role: "assistant",
        content: neutralizeUntrusted(head(model.data.text ?? "", BRIEF_SHARES.modelText)),
      };
      assistants.push(assistant);
      messages.push(assistant);
    } else if (event.type === "TOOL_CALL") {
      const call = toolCallSchema.safeParse(event.payload);
      if (!call.success) continue;
      const { callId, tool, ...args } = call.data;
      toolNames.set(callId, tool);
      if (assistant === null) {
        assistant = { role: "assistant", content: "" };
        assistants.push(assistant);
        messages.push(assistant);
      }
      assistant.tool_calls = [
        ...(assistant.tool_calls ?? []),
        {
          function: {
            name: tool,
            arguments: Object.fromEntries(
              Object.entries(args).map(([key, value]) => [
                FROM_PROTOCOL[key] ?? key,
                typeof value === "string" ? neutralizeUntrusted(value) : value,
              ]),
            ),
          },
        },
      ];
    } else if (event.type === "TOOL_RESULT") {
      const result = resultSchema.safeParse(event.payload);
      if (!result.success) continue;
      assistant = null;
      const parts: ToolParts = { ...result.data, feedback: "" };
      const message: HealMessage = {
        role: "tool",
        tool_name: toolNames.get(result.data.callId) ?? "unknown",
        content: toolContent(parts),
      };
      toolParts.set(message, parts);
      byCall.set(result.data.callId, message);
      messages.push(message);
    } else if (event.type === "POLICY_CHECK") {
      const check = policySchema.safeParse(event.payload);
      const message = check.success ? byCall.get(check.data.callId) : undefined;
      const parts = message === undefined ? undefined : toolParts.get(message);
      if (!check.success || message === undefined || parts === undefined) continue;
      if (check.data.violations.length === 0) continue;
      parts.feedback = feedback(check.data.violations);
      message.content = toolContent(parts);
    }
  }

  // Too long: tool outputs become a note, oldest first; then long call arguments are cut.
  let total = messages.reduce((sum, message) => sum + size(message), 0);
  for (const [message, parts] of toolParts) {
    if (total <= input.tokenBudget) break;
    const before = size(message);
    message.content = toolContent(parts, true);
    total += size(message) - before;
  }
  for (const message of assistants) {
    if (total <= input.tokenBudget) break;
    if (message.tool_calls === undefined) continue;
    const before = size(message);
    message.tool_calls = message.tool_calls.map(shortened);
    total += size(message) - before;
  }
  return { messages, estimatedTokens: total, overBudget: total > input.tokenBudget };
}

export interface StopInput {
  history: readonly TimelineEvent[];
  limits: { maxModelTokens: number; maxWallClockMinutes: number };
  /** When the session opened: the attempt's clock. */
  startedAt: Date;
  now: Date;
}

/**
 * Why the loop must stop before another model call (SPEC §7.3), or null. A rule counts as broken
 * again only for a violation not seen before: every edit returns the cumulative diff, so one bad
 * edit would otherwise count again with each later edit (review M4).
 */
export function stopReason(input: StopInput): string | null {
  let tokens = 0;
  const seen = new Set<string>();
  const breaches = new Map<string, number>();
  for (const event of input.history) {
    if (event.type === "MODEL_CALL") {
      const model = modelSchema.safeParse(event.payload);
      if (model.success) tokens += model.data.inputTokens + model.data.outputTokens;
    } else if (event.type === "POLICY_CHECK") {
      const check = policySchema.safeParse(event.payload);
      if (!check.success) continue;
      for (const violation of check.data.violations) {
        const key = `${violation.ruleId}\u0000${violation.path ?? ""}\u0000${violation.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        breaches.set(violation.ruleId, (breaches.get(violation.ruleId) ?? 0) + 1);
      }
    }
  }
  if (tokens >= input.limits.maxModelTokens) return "model token cap reached";
  const elapsedMinutes = (input.now.getTime() - input.startedAt.getTime()) / 60_000;
  if (elapsedMinutes >= input.limits.maxWallClockMinutes) return "wall-clock cap reached";
  for (const [ruleId, count] of breaches) {
    if (count >= 3) return `the same rule was violated 3 times: ${ruleId}`;
  }
  return null;
}

/** Bounds of a stored policy check (packages/db's policyChecksSchema). */
export const POLICY_CHECK_BOUNDS = { violations: 50, ruleId: 100, message: 1_000, path: 4_096 };

export type EditCheck =
  | { ok: true; violations: { ruleId: string; message: string; path: string | null }[] }
  | { ok: false; error: string };

/**
 * The static checks on an edit's cumulative diff (SPEC §7.2): fast feedback for the model. The
 * runner sends the diff, so this is guidance only; the submission is checked again from the
 * file contents the server fetches itself (§7, step 10). Clamped to what is stored.
 */
export function editViolations(diff: string, policy: EffectivePolicy): EditCheck {
  if (diff.trim() === "") return { ok: true, violations: [] };
  const read = parseUnifiedDiff(diff);
  if (!read.ok) return { ok: false, error: read.error };
  return {
    ok: true,
    violations: checkChanges(read.changes.map(buildChange), policy)
      .slice(0, POLICY_CHECK_BOUNDS.violations)
      .map((violation) => ({
        ruleId: violation.ruleId.slice(0, POLICY_CHECK_BOUNDS.ruleId),
        message: violation.message.slice(0, POLICY_CHECK_BOUNDS.message),
        path: violation.path?.slice(0, POLICY_CHECK_BOUNDS.path) ?? null,
      })),
  };
}
