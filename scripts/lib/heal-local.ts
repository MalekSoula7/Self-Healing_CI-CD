// `pnpm heal:local` (P4.6): the pure parts. Which check each scenario fails, the demo repositories'
// commands (argv arrays, SPEC §7.2), and the container that runs heal-action's local entry.
import type { Demo, Scenario } from "./break-scenarios";

export type LocalCheck = "install" | "build" | "lint" | "typecheck" | "test";

export interface DemoSetup {
  commands: Partial<Record<LocalCheck | "testFile", string[]>>;
  junitGlob: string | null;
  /** The runner image: heal-action needs Node 24, git, and the demo's toolchain. */
  image: string;
}

/** Demos local mode can run. Python needs an image with both Node and Python: not yet. */
export const DEMO_SETUPS: Partial<Record<Demo, DemoSetup>> = {
  node: {
    commands: {
      install: ["npm", "ci", "--no-audit", "--no-fund"],
      typecheck: ["npm", "run", "typecheck"],
      lint: ["npm", "run", "lint"],
      test: ["npm", "run", "test:ci"],
      testFile: ["npx", "vitest", "run"],
    },
    junitGlob: "reports/junit.xml",
    // Pinned by digest: the image runs the model's edits next to the session (P4.6 review L4).
    image:
      "node:24-bookworm@sha256:49f7adaf9f1574bc45c20ea317139b39a59d7e758d0e93745e112fd85cb42623",
  },
};

/** The check a scenario's failure shows up in, as its category says (SPEC §14). */
export function failingCheckFor(scenario: Scenario): LocalCheck {
  switch (scenario.category) {
    case "typecheck":
      return "typecheck";
    case "lint":
      return "lint";
    // TypeScript reports a missing import when type-checking; Python when importing in tests.
    case "compile":
      return scenario.demo === "node" ? "typecheck" : "test";
    default:
      return "test";
  }
}

export interface ContainerOptions {
  /** A name, so a run that outlives its timeout can be killed. */
  name: string;
  /** The broken checkout, mounted read-write at /work. */
  workDir: string;
  /** packages/heal-action/dist, mounted read-only at /action. */
  actionDir: string;
  image: string;
}

/**
 * `docker run` arguments for heal-action's local entry. The session comes on stdin (`-i`): never
 * on the command line or in the container's environment, where code under test could read it.
 * The gateway URL is passed by name only. The container runs as the image's unprivileged `node`
 * user, with no capabilities, no privilege escalation, and bounded processes, memory and CPU.
 */
export function containerArgs(options: ContainerOptions): string[] {
  return [
    "run",
    "--rm",
    "--interactive",
    "--name",
    options.name,
    "--user",
    "node",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=512",
    "--memory=4g",
    "--cpus=2",
    // The developer's gateway, reached from inside the container.
    "--add-host=host.docker.internal:host-gateway",
    "--volume",
    `${options.workDir}:/work`,
    "--volume",
    `${options.actionDir}:/action:ro`,
    "--workdir",
    "/work",
    "--env",
    "PIPEHEAL_LOCAL_GATEWAY",
    // The mounted checkout belongs to another user: git refuses it unless told it's safe.
    "--env",
    "GIT_CONFIG_COUNT=1",
    "--env",
    "GIT_CONFIG_KEY_0=safe.directory",
    "--env",
    "GIT_CONFIG_VALUE_0=/work",
    options.image,
    "node",
    "/action/local.mjs",
  ];
}

function detailOf(type: string, payload: Record<string, unknown>): string {
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  switch (type) {
    case "TOOL_CALL":
      return `${text(payload.tool)} ${text(payload.path) || text(payload.name)}`;
    case "TOOL_RESULT":
      return `ok=${String(payload.ok)}`;
    case "MODEL_CALL":
      return `${String(payload.inputTokens)} in / ${String(payload.outputTokens)} out`;
    case "POLICY_CHECK":
      return `${Array.isArray(payload.violations) ? String(payload.violations.length) : "?"} violations`;
    default:
      return text(payload.kind);
  }
}

/** Model- or repository-made text, safe for a terminal: no control or escape characters. */
export function terminalSafe(text: string, max = 200): string {
  let safe = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    safe += code < 0x20 || (code >= 0x7f && code < 0xa0) ? "?" : char;
  }
  return safe.length > max ? `${safe.slice(0, max)}...` : safe;
}

/** One line per timeline event, for the end of a local run (paths come from the model). */
export function timelineLine(event: { stepSeq: number; type: string; payload: unknown }): string {
  const payload =
    typeof event.payload === "object" && event.payload !== null
      ? (event.payload as Record<string, unknown>)
      : {};
  const line = `step ${String(event.stepSeq).padStart(2)}  ${event.type.padEnd(12)} ${detailOf(event.type, payload)}`;
  return terminalSafe(line, 300).trimEnd();
}
