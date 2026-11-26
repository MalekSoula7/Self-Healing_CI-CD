// The runner <-> gateway protocol (SPEC §3.1, §5.4, §7.2; D15: steps are async and long-polled).
// Pure zod, no I/O: the gateway (apps/worker) and the runner (packages/heal-action) both import it
// through `@pipeheal/shared/protocol`. Shapes and sizes only: the gateway re-checks everything the
// runner sends against the attempt's state and the policy engine. The server never trusts the runner.
//
//   POST /v1/session        { oidcToken, attemptId }      -> { sessionToken, expiresAt, attempt }
//   POST /v1/step           { stepSeq, start | toolResults } -> 202 { stepSeq }
//   GET  /v1/step/:stepSeq  (long-poll)                   -> pending | ready (tool calls) | done
//   POST /v1/submission     final file contents, checks, reports
import { z } from "zod";
import { repoPathProblem } from "./repo-path";

export const PROTOCOL_VERSION = 1;

export const LIMITS = {
  /** Characters in one file's content (write_file, submissions). */
  fileBytes: 512_000,
  /** Characters in one tool result or check output; the runner truncates before sending. */
  toolOutputChars: 64_000,
  /** Characters in a model-written string argument (patterns, diagnoses, edits' old/new text). */
  textChars: 64_000,
  toolCallsPerStep: 16,
  fileTreeEntries: 10_000,
  /** JUnit reports per request, and characters per report. */
  reports: 10,
  reportChars: 5_000_000,
  submissionFiles: 200,
  checksPerSubmission: 8,
  commandArgs: 64,
  commandArgChars: 1_000,
  maxStepSeq: 1_000,
  maxRetryAfterMs: 30_000,
} as const;

/**
 * Request body limits (bytes) the gateway enforces per route, before parsing; every other route
 * gets `default`. They cap a request's total, which the per-item `LIMITS` alone don't.
 */
export const BODY_LIMITS = {
  default: 16 * 1024,
  session: 16 * 1024,
  /** Tool results, or the first step's file tree and baseline reports. */
  step: 24 * 1024 * 1024,
  /** Final file contents, checks and reports. */
  submission: 64 * 1024 * 1024,
} as const;

const repoPath = z
  .string()
  .max(4096)
  .refine((path) => repoPathProblem(path) === null, "not a repository-relative POSIX path");
/** A path argument where "." names the repository root. */
const repoPathOrRoot = z.union([z.literal("."), repoPath]);
const text = (max: number = LIMITS.textChars) => z.string().max(max);
const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export const checkNameSchema = z.enum([
  "install",
  "build",
  "lint",
  "typecheck",
  "test",
  "test_file",
]);
export type CheckName = z.infer<typeof checkNameSchema>;

// --- Session -----------------------------------------------------------------------------------

export const sessionRequestSchema = z.strictObject({
  /** GitHub Actions OIDC token (a JWT); verified by the gateway against GitHub's JWKS. */
  oidcToken: z
    .string()
    .max(8_192)
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  attemptId: z.uuid(),
});
export type SessionRequest = z.infer<typeof sessionRequestSchema>;

/** A command as an argv array, never a shell string (SPEC §7.2). */
const commandSchema = z
  .array(z.string().min(1).max(LIMITS.commandArgChars))
  .min(1)
  .max(LIMITS.commandArgs);

export const attemptCommandsSchema = z.strictObject({
  install: commandSchema.optional(),
  build: commandSchema.optional(),
  lint: commandSchema.optional(),
  typecheck: commandSchema.optional(),
  test: commandSchema.optional(),
  /** Run with the target path appended as its last argument. */
  testFile: commandSchema.optional(),
});
export type AttemptCommands = z.infer<typeof attemptCommandsSchema>;

export const sessionResponseSchema = z.strictObject({
  /** Opaque bearer token for the following calls; only its hash is stored. */
  sessionToken: z.string().min(32).max(256),
  expiresAt: z.iso.datetime(),
  attempt: z.strictObject({
    targetSha: z.string().regex(/^[0-9a-f]{40}$/),
    failingCheck: checkNameSchema,
    commands: attemptCommandsSchema,
    junitGlob: z.string().min(1).max(512).nullable(),
    wallClockMinutes: z.int().min(1).max(120),
  }),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

// --- Tool calls (SPEC §7.2), sent by the gateway, executed by the runner ------------------------

export const toolCallSchema = z.discriminatedUnion("tool", [
  z.strictObject({
    callId: id,
    tool: z.literal("list_files"),
    path: repoPathOrRoot,
    depth: z.int().min(1).max(10).optional(),
  }),
  z.strictObject({
    callId: id,
    tool: z.literal("read_file"),
    path: repoPath,
    start: z.int().min(1).optional(),
    end: z.int().min(1).optional(),
  }),
  z.strictObject({
    callId: id,
    tool: z.literal("search_code"),
    pattern: z.string().min(1).max(1_000),
    glob: z.string().min(1).max(512).optional(),
  }),
  z.strictObject({
    callId: id,
    tool: z.literal("apply_edit"),
    path: repoPath,
    oldStr: z.string().min(1).max(LIMITS.textChars),
    newStr: text(),
  }),
  z.strictObject({
    callId: id,
    tool: z.literal("write_file"),
    path: repoPath,
    content: text(LIMITS.fileBytes),
  }),
  z.strictObject({
    callId: id,
    tool: z.literal("run_check"),
    name: checkNameSchema,
    target: repoPath.optional(),
  }),
  z.strictObject({
    callId: id,
    tool: z.literal("submit_fix"),
    rootCause: text(4_000),
    changes: text(4_000),
    verification: text(4_000),
    confidence: z.enum(["low", "medium", "high"]),
  }),
  z.strictObject({
    callId: id,
    tool: z.literal("give_up"),
    diagnosis: text(4_000),
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
    suggestedNextStep: text(4_000),
  }),
]);
export type ToolCall = z.infer<typeof toolCallSchema>;
export type ToolName = ToolCall["tool"];

// --- Steps (D15) --------------------------------------------------------------------------------

const checkResultSchema = z.strictObject({
  name: checkNameSchema,
  /** null when the command was killed (timeout) or isn't configured. */
  exitCode: z.int().min(-1).max(255).nullable(),
  /** Tail of the output, truncated by the runner; redacted again by the gateway. */
  output: text(LIMITS.toolOutputChars),
});
export type CheckResult = z.infer<typeof checkResultSchema>;

const reportSchema = z.strictObject({
  path: repoPath,
  xml: z.string().max(LIMITS.reportChars),
});

export const toolResultSchema = z.strictObject({
  callId: id,
  ok: z.boolean(),
  output: text(LIMITS.toolOutputChars),
  /** Set when the runner had to cut the output down to the limit. */
  truncated: z.boolean().optional(),
});
export type ToolResult = z.infer<typeof toolResultSchema>;

const stepSeqSchema = z.int().min(1).max(LIMITS.maxStepSeq);

export const stepRequestSchema = z.union([
  z.strictObject({
    stepSeq: stepSeqSchema,
    /** Step 1: what the runner saw before any model call (SPEC §7.3). */
    start: z.strictObject({
      reproduced: z.boolean(),
      check: checkResultSchema,
      fileTree: z.array(repoPath).max(LIMITS.fileTreeEntries),
      reports: z.array(reportSchema).max(LIMITS.reports),
    }),
  }),
  z.strictObject({
    stepSeq: stepSeqSchema,
    toolResults: z.array(toolResultSchema).min(1).max(LIMITS.toolCallsPerStep),
  }),
]);
export type StepRequest = z.infer<typeof stepRequestSchema>;

export const stepAcceptedSchema = z.strictObject({ stepSeq: stepSeqSchema });

export const stepPollResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("pending"),
    stepSeq: stepSeqSchema,
    retryAfterMs: z.int().min(0).max(LIMITS.maxRetryAfterMs),
  }),
  z.strictObject({
    status: z.literal("ready"),
    stepSeq: stepSeqSchema,
    toolCalls: z.array(toolCallSchema).min(1).max(LIMITS.toolCallsPerStep),
  }),
  z.strictObject({
    status: z.literal("done"),
    stepSeq: stepSeqSchema,
    /** submit: the runner runs the full checks and posts a submission. Anything else: stop. */
    outcome: z.enum(["submit", "gave_up", "not_reproducible", "stopped"]),
    reason: text(4_000),
  }),
]);
export type StepPollResponse = z.infer<typeof stepPollResponseSchema>;

// --- Submission ---------------------------------------------------------------------------------

/** Final contents, never a diff: the server rebuilds the diff from the target commit. */
const submittedFileSchema = z.union([
  z.strictObject({ path: repoPath, content: text(LIMITS.fileBytes) }),
  z.strictObject({ path: repoPath, deleted: z.literal(true) }),
]);

export const submissionSchema = z.strictObject({
  files: z.array(submittedFileSchema).min(1).max(LIMITS.submissionFiles),
  checks: z.array(checkResultSchema).max(LIMITS.checksPerSubmission),
  reports: z.array(reportSchema).max(LIMITS.reports),
});
export type Submission = z.infer<typeof submissionSchema>;
