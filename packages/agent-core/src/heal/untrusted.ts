// Untrusted text in a prompt (CLAUDE.md: repository content and CI logs can't change the agent's
// instructions). Two layers can be forged by text that reaches the model:
// - the chat template itself: qwen3's ChatML tokens (`<|im_start|>`, `<|im_end|>`) and its tool
//   and thinking tags (`<tool_call>`, `<tool_response>`, `<think>`) could fake a system turn or a
//   tool result if the server tokenizes them as special tokens;
// - PipeHeal's own wrapper tags (`<ci_log>`, `<tool_output>`, `<policy_feedback>`...), which mark
//   where untrusted data starts and ends and what the server said.
// Both are broken up with a zero-width space, whatever their case or spacing. Everything else is
// kept as written: the model must see code exactly (apply_edit matches it byte for byte).

const ZWSP = "​";

/** Tags of the chat template that a model reads as structure. */
const TEMPLATE_TAGS = ["tool_call", "tool_response", "think"];
/** Tags PipeHeal's prompts use to mark untrusted data and server feedback. */
export const PROMPT_TAGS = [
  "ci_log",
  "recent_changes",
  "reproduction",
  "file_tree",
  "triage_summary",
  "tool_output",
  "policy_feedback",
  "repo_rules",
  "rules",
  "untrusted_input",
  "how_to_work",
  "never",
];

function tagPattern(names: readonly string[]): RegExp {
  // `<`, optional spacing and slash, the name, then anything but a name character.
  return new RegExp(`<(\\s*/?\\s*)(${names.join("|")})(?![\\w-])`, "gi");
}

const TEMPLATE_TAG = tagPattern(TEMPLATE_TAGS);
const ANY_TAG = tagPattern([...TEMPLATE_TAGS, ...PROMPT_TAGS]);

/** The chat template's special markers, broken up (for every message but the system prompt). */
export function neutralizeChatTokens(text: string): string {
  return text
    .replace(/<\|/g, `<${ZWSP}|`)
    .replace(/\|>/g, `|${ZWSP}>`)
    .replace(TEMPLATE_TAG, `<${ZWSP}$1$2`);
}

/** Untrusted data inside a prompt: chat markers and every prompt tag broken up. */
export function neutralizeUntrusted(text: string): string {
  return neutralizeChatTokens(text).replace(ANY_TAG, `<${ZWSP}$1$2`);
}

/** A short untrusted value on one line (names, branches, commands): no control characters. */
export function oneLineUntrusted(text: string, max: number): string {
  let line = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    line += code < 0x20 || code === 0x7f ? " " : char;
  }
  return neutralizeUntrusted(line.replace(/\s+/g, " ").trim().slice(0, max));
}
