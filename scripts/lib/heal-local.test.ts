// `pnpm heal:local`'s pure parts (P4.6).
import { describe, expect, it } from "vitest";
import { SCENARIOS, findScenario } from "./break-scenarios";
import {
  DEMO_SETUPS,
  containerArgs,
  failingCheckFor,
  terminalSafe,
  timelineLine,
} from "./heal-local";

describe("failingCheckFor", () => {
  it.each([
    ["node/type-error", "typecheck"],
    ["node/lint", "lint"],
    ["node/logic-bug", "test"],
    ["node/missing-import", "typecheck"],
    ["python/missing-import", "test"],
  ])("%s fails %s", (id, check) => {
    const scenario = findScenario(id);
    expect(scenario && failingCheckFor(scenario)).toBe(check);
  });

  it("names a check for every scenario", () => {
    for (const scenario of SCENARIOS) {
      expect(["install", "build", "lint", "typecheck", "test"]).toContain(
        failingCheckFor(scenario),
      );
    }
  });
});

describe("DEMO_SETUPS", () => {
  it("configures the node demo with argv commands and its JUnit report", () => {
    const node = DEMO_SETUPS.node;

    expect(node?.junitGlob).toBe("reports/junit.xml");
    for (const argv of Object.values(node?.commands ?? {})) {
      expect(argv.every((arg) => !arg.includes(" "))).toBe(true);
    }
  });
});

describe("containerArgs", () => {
  it("mounts the checkout and the action, hardened, with the session on stdin only", () => {
    const args = containerArgs({
      name: "pipeheal-local-1",
      workDir: "C:\\tmp\\work",
      actionDir: "D:\\dist",
      image: "node:24",
    });

    expect(args).toEqual(
      expect.arrayContaining(["--rm", "C:\\tmp\\work:/work", "D:\\dist:/action:ro", "node:24"]),
    );
    expect(args.slice(-2)).toEqual(["node", "/action/local.mjs"]);
    expect(args).toEqual(
      expect.arrayContaining([
        "--interactive",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
      ]),
    );
    expect(args[args.indexOf("--user") + 1]).toBe("node");
    // The session never travels as an argument or an environment variable.
    expect(args.some((arg) => arg.includes("SESSION"))).toBe(false);
  });
});

describe("terminalSafe", () => {
  it("replaces control and escape characters, and caps the length", () => {
    const escape = String.fromCharCode(27);
    const bell = String.fromCharCode(7);

    expect(terminalSafe(`a${escape}]0;pwned${bell}b`)).toBe("a?]0;pwned?b");
    expect(terminalSafe("x".repeat(300))).toHaveLength(203);
  });
});

describe("timelineLine", () => {
  it("summarises each kind of event on one line", () => {
    expect(timelineLine({ stepSeq: 1, type: "INFO", payload: { kind: "start" } })).toBe(
      "step  1  INFO         start",
    );
    expect(
      timelineLine({ stepSeq: 1, type: "TOOL_CALL", payload: { tool: "read_file", path: "a.ts" } }),
    ).toBe("step  1  TOOL_CALL    read_file a.ts");
    expect(
      timelineLine({ stepSeq: 1, type: "TOOL_CALL", payload: { tool: "run_check", name: "test" } }),
    ).toBe("step  1  TOOL_CALL    run_check test");
    expect(timelineLine({ stepSeq: 2, type: "TOOL_RESULT", payload: { ok: true } })).toBe(
      "step  2  TOOL_RESULT  ok=true",
    );
    expect(
      timelineLine({
        stepSeq: 2,
        type: "MODEL_CALL",
        payload: { inputTokens: 9, outputTokens: 1 },
      }),
    ).toBe("step  2  MODEL_CALL   9 in / 1 out");
    expect(timelineLine({ stepSeq: 3, type: "POLICY_CHECK", payload: { violations: [] } })).toBe(
      "step  3  POLICY_CHECK 0 violations",
    );
    expect(timelineLine({ stepSeq: 3, type: "INFO", payload: null })).toBe("step  3  INFO");
  });
});
