// @pipeheal/agent-core: log cleaning, redaction, triage, prompts, tool schemas, agent loop
// controller. Pure logic; I/O stays in the apps.
export { MAX_LINE_LENGTH, cleanLog } from "./logs/clean";
export { redactLog, type RedactionKind, type RedactionResult } from "./redact/redact";
