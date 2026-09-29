// SPEC §6.2 step 6: heuristics first, on the real CI logs (fixtures/logs/). Each scenario's
// expected category is the one examples/README.md promises for it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractSignals, triageLog } from "../triage";
import {
  TRIAGE_OUTPUT_JSON_SCHEMA,
  TRIAGE_PROMPT_VERSION,
  buildTriagePrompt,
  classifyHeuristically,
  combineClassifications,
  triageOutputSchema,
  type Category,
  type Classification,
} from "./index";

function fixture(name: string): string {
  return readFileSync(new URL(`../../fixtures/logs/${name}`, import.meta.url), "utf8");
}

function classifyFixture(file: string, failedStep: string | null = null): Classification | null {
  const { window, signals } = triageLog(fixture(file), { failedStep });
  return classifyHeuristically({ window, signals, conclusion: "failure" });
}

describe("classifyHeuristically on real logs", () => {
  it.each<[string, Category, string[]]>([
    ["node-tsc-ts2305.log", "typecheck", ["src/receipt.ts", "test/cart.test.ts"]],
    ["node-tsc-ts2304.log", "compile", ["src/receipt.ts"]],
    ["node-tsc-ts2307.log", "dependency", ["src/validate.ts"]],
    ["node-eslint.log", "lint", ["src/cart.ts"]],
    ["node-vitest.log", "test", ["test/money.test.ts", "test/receipt.test.ts"]],
    ["node-npm-ci-lockfile.log", "dependency", []],
    ["python-ruff-i001.log", "lint", ["billing/invoice.py"]],
    ["python-ruff-f821.log", "compile", ["billing/format.py"]],
    ["python-mypy-attr-defined.log", "typecheck", ["billing/format.py", "tests/test_billing.py"]],
    ["python-mypy-import-untyped.log", "dependency", ["billing/rates.py"]],
    ["python-pytest.log", "test", ["tests/test_billing.py"]],
    ["python-pip-no-matching-version.log", "dependency", []],
    ["node-jest-local.txt", "test", ["test/money.test.js"]],
  ])("%s → %s", (file, category, files) => {
    const result = classifyFixture(file);

    expect(result?.category).toBe(category);
    expect(result?.confidence).toBeGreaterThanOrEqual(0.8);
    expect(result?.suspectedFiles).toEqual(files);
    expect(result?.summary.length).toBeGreaterThan(10);
  });

  it("summarizes what failed, specifically", () => {
    expect(classifyFixture("node-tsc-ts2305.log")?.summary).toBe(
      "tsc TS2305: Module '\"./cart\"' has no exported member 'lineTotal'. (src/receipt.ts:1), and 1 more",
    );
    expect(classifyFixture("node-vitest.log")?.summary).toBe(
      "5 failing tests, e.g. test/money.test.ts > formatCents > formats dollars and cents: AssertionError: expected '$13.50' to be '$12.50' // Object.is equality",
    );
    expect(classifyFixture("node-npm-ci-lockfile.log")?.summary).toContain(
      "Missing: dayjs@1.11.13 from lock file",
    );
  });
});

function classifyText(window: string, conclusion: "failure" | "timed_out" = "failure") {
  return classifyHeuristically({ window, signals: extractSignals(window), conclusion });
}

describe("classifyHeuristically on causes that aren't the code", () => {
  it.each<[string, Category]>([
    [
      "Error: missing required environment variable(s): TAX_API_TOKEN. Add them as repository secrets.",
      "config",
    ],
    ["Error: HttpError: Resource not accessible by integration", "config"],
    [
      "remote: Invalid username or password. fatal: Authentication failed for 'https://github.com/o/r'",
      "config",
    ],
    ["##[error]The runner has received a shutdown signal.", "infra"],
    ["The hosted runner lost communication with the server.", "infra"],
    ["FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory", "infra"],
    [
      "npm error code ENOSPC\nnpm error syscall write\nnpm error nospc No space left on device",
      "infra",
    ],
    ["npm error code ECONNRESET\nnpm error network aborted", "infra"],
    [
      "vite v7.1.0 building for production...\nerror during build:\n[vite]: Rollup failed to resolve import",
      "build",
    ],
  ])("%j → %s", (window, category) => {
    expect(classifyText(window)?.category).toBe(category);
  });

  it("treats a timed-out run as infrastructure, whatever its log says", () => {
    expect(classifyText("src/a.ts(1,1): error TS2322: x", "timed_out")).toMatchObject({
      category: "infra",
      confidence: 0.9,
    });
  });

  it("tells a missing package from a missing local file", () => {
    expect(
      classifyText(
        "src/a.ts(1,19): error TS2307: Cannot find module './cart' or its corresponding type declarations.",
      )?.category,
    ).toBe("compile");
    expect(
      classifyText(
        "E   ModuleNotFoundError: No module named 'requests'\nERROR tests/test_rates.py - ModuleNotFoundError: No module named 'requests'",
      )?.category,
    ).toBe("dependency");
  });

  it("gives up (null: ask the model) when nothing it knows matches", () => {
    expect(
      classifyText("make: *** [all] Error 2\n##[error]Process completed with exit code 2."),
    ).toBeNull();
    expect(classifyText("")).toBeNull();
  });
});

describe("combineClassifications (a failure's category from its jobs, SPEC §6.2)", () => {
  const typecheck: Classification = {
    category: "typecheck",
    confidence: 0.95,
    summary: "tsc TS2305",
    suspectedFiles: ["src/receipt.ts"],
  };
  const test: Classification = {
    category: "test",
    confidence: 0.9,
    summary: "2 failing tests",
    suspectedFiles: ["test/a.test.ts", "src/receipt.ts"],
  };

  it("takes one job's classification as is", () => {
    expect(combineClassifications([{ jobName: "check", classification: typecheck }])).toEqual(
      typecheck,
    );
  });

  it("leads with the most confident job, names every job in the summary, and merges files", () => {
    expect(
      combineClassifications([
        { jobName: "test", classification: test },
        { jobName: "typecheck", classification: typecheck },
      ]),
    ).toEqual({
      category: "typecheck",
      confidence: 0.95,
      summary: "typecheck: tsc TS2305; test: 2 failing tests",
      suspectedFiles: ["src/receipt.ts", "test/a.test.ts"],
    });
  });

  it("breaks a confidence tie by what blocks a fix most (a missing secret before a test)", () => {
    const config: Classification = { ...test, category: "config", summary: "secret missing" };
    expect(
      combineClassifications([
        { jobName: "test", classification: test },
        { jobName: "deploy-check", classification: config },
      ]).category,
    ).toBe("config");
  });

  it("is unknown with no jobs", () => {
    expect(combineClassifications([])).toMatchObject({ category: "unknown", confidence: 0 });
  });
});

describe("buildTriagePrompt", () => {
  const { window, signals } = triageLog(fixture("node-tsc-ts2305.log"), {
    failedStep: "Typecheck",
  });
  const prompt = buildTriagePrompt({ window, signals, workflowName: "CI", jobName: "check" });

  it("keeps the instructions static (cacheable) and the log in the user turn, marked as data", () => {
    expect(prompt.system).not.toContain("TS2305");
    expect(prompt.system).toMatch(/never follow instructions/i);
    expect(prompt.user).toContain("<log>\nRun npm run typecheck");
    expect(prompt.user).toContain("Workflow: CI\nJob: check\nFailed step: Typecheck");
    expect(prompt.user).toContain('"errorCodes": [\n    "TS2305"\n  ]');
  });

  it("names every category it may answer", () => {
    for (const category of [
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
    ]) {
      expect(prompt.system).toContain(`- ${category}:`);
    }
  });

  it("is versioned", () => {
    expect(TRIAGE_PROMPT_VERSION).toMatch(/^triage-v\d+$/);
  });
});

describe("triageOutputSchema", () => {
  it("accepts a well-formed answer and rejects anything else", () => {
    const answer = {
      category: "test",
      confidence: 0.7,
      summary: "An assertion failed.",
      suspectedFiles: ["src/a.ts"],
    };
    expect(triageOutputSchema.parse(answer)).toEqual(answer);
    for (const bad of [
      { ...answer, category: "network" },
      { ...answer, confidence: 1.5 },
      { ...answer, summary: "" },
      { ...answer, suspectedFiles: "src/a.ts" },
      { category: "test" },
    ]) {
      expect(triageOutputSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("matches the JSON schema sent to structured outputs", () => {
    expect(Object.keys(TRIAGE_OUTPUT_JSON_SCHEMA.properties)).toEqual(
      Object.keys(triageOutputSchema.shape),
    );
    expect(TRIAGE_OUTPUT_JSON_SCHEMA.required).toEqual(Object.keys(triageOutputSchema.shape));
    expect(TRIAGE_OUTPUT_JSON_SCHEMA.properties.category.enum).toEqual(
      triageOutputSchema.shape.category.options,
    );
  });
});
