// SPEC §6.2 steps 4-5, against real CI logs (fixtures/logs/README.md): the failed step, its
// error window, and the signals parsed from it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_WINDOW_LINES,
  extractErrorWindow,
  extractSignals,
  failedStepLog,
  triageLog,
  type Location,
  type Tool,
} from "./index";

function fixture(name: string): string {
  return readFileSync(new URL(`../../fixtures/logs/${name}`, import.meta.url), "utf8");
}

interface Case {
  file: string;
  failedStep: string;
  command: string;
  exitCode: number;
  tools: Tool[];
  errorCodes: string[];
  failingTests: string[];
  locations: Location[];
  /** Lines the window must show. */
  shows: string[];
  /** A diagnostic message that must be parsed (substring). */
  message: string;
}

const CASES: Case[] = [
  {
    file: "node-tsc-ts2305.log",
    failedStep: "Typecheck",
    command: "Run npm run typecheck",
    exitCode: 2,
    tools: ["tsc"],
    errorCodes: ["TS2305"],
    failingTests: [],
    locations: [
      { path: "src/receipt.ts", line: 1, column: 25 },
      { path: "test/cart.test.ts", line: 2, column: 25 },
    ],
    shows: [
      "src/receipt.ts(1,25): error TS2305: Module '\"./cart\"' has no exported member 'lineTotal'.",
    ],
    message: "has no exported member 'lineTotal'",
  },
  {
    file: "node-tsc-ts2304.log",
    failedStep: "Typecheck",
    command: "Run npm run typecheck",
    exitCode: 2,
    tools: ["tsc"],
    errorCodes: ["TS2304"],
    failingTests: [],
    locations: [
      { path: "src/receipt.ts", line: 6, column: 58 },
      { path: "src/receipt.ts", line: 9, column: 24 },
    ],
    shows: ["src/receipt.ts(6,58): error TS2304: Cannot find name 'formatCents'."],
    message: "Cannot find name 'formatCents'",
  },
  {
    file: "node-tsc-ts2307.log",
    failedStep: "Typecheck",
    command: "Run npm run typecheck",
    exitCode: 2,
    tools: ["tsc"],
    errorCodes: ["TS2307"],
    failingTests: [],
    locations: [{ path: "src/validate.ts", line: 1, column: 19 }],
    shows: ["error TS2307: Cannot find module 'zod' or its corresponding type declarations."],
    message: "Cannot find module 'zod'",
  },
  {
    file: "node-eslint.log",
    failedStep: "Lint",
    command: "Run npm run lint",
    exitCode: 1,
    tools: ["eslint"],
    errorCodes: ["@typescript-eslint/no-unused-vars"],
    failingTests: [],
    locations: [{ path: "src/cart.ts", line: 12, column: 9 }],
    shows: ["'itemCount' is assigned a value but never used", "✖ 1 problem (1 error, 0 warnings)"],
    message: "'itemCount' is assigned a value but never used",
  },
  {
    file: "node-vitest.log",
    failedStep: "Test",
    command: "Run npm run test:ci",
    exitCode: 1,
    tools: ["vitest"],
    errorCodes: [],
    failingTests: [
      "test/money.test.ts > formatCents > formats dollars and cents",
      "test/money.test.ts > formatCents > groups thousands",
      "test/money.test.ts > formatCents > formats refunds as negative amounts",
      "test/receipt.test.ts > receiptLines > prints each line and the total",
      "test/receipt.test.ts > receiptLines > shows the discount and the discounted total",
    ],
    locations: [
      { path: "test/money.test.ts", line: 7, column: 31 },
      { path: "test/money.test.ts", line: 12, column: 36 },
      { path: "test/receipt.test.ts", line: 15, column: 37 },
    ],
    shows: ["AssertionError: expected '$13.50' to be '$12.50' // Object.is equality"],
    message: "expected '$13.50' to be '$12.50'",
  },
  {
    file: "node-npm-ci-lockfile.log",
    failedStep: "Install dependencies",
    command: "Run npm ci",
    exitCode: 1,
    tools: ["npm"],
    errorCodes: ["EUSAGE"],
    failingTests: [],
    locations: [],
    shows: ["npm error code EUSAGE", "npm error Missing: dayjs@1.11.13 from lock file"],
    message: "Missing: dayjs@1.11.13 from lock file",
  },
  {
    file: "python-ruff-i001.log",
    failedStep: "Lint",
    command: "Run ruff check .",
    exitCode: 1,
    tools: ["ruff"],
    errorCodes: ["I001"],
    failingTests: [],
    locations: [{ path: "billing/invoice.py", line: 3, column: 1 }],
    shows: ["I001 [*] Import block is un-sorted or un-formatted", " --> billing/invoice.py:3:1"],
    message: "Import block is un-sorted or un-formatted",
  },
  {
    file: "python-ruff-f821.log",
    failedStep: "Lint",
    command: "Run ruff check .",
    exitCode: 1,
    tools: ["ruff"],
    errorCodes: ["F821"],
    failingTests: [],
    locations: [{ path: "billing/format.py", line: 6, column: 26 }],
    shows: ["F821 Undefined name `Decimal`"],
    message: "Undefined name `Decimal`",
  },
  {
    file: "python-mypy-attr-defined.log",
    failedStep: "Typecheck",
    command: "Run mypy",
    exitCode: 1,
    tools: ["mypy"],
    errorCodes: ["attr-defined"],
    failingTests: [],
    locations: [
      { path: "billing/format.py", line: 5 },
      { path: "tests/test_billing.py", line: 5 },
    ],
    shows: ['billing/format.py:5: error: Module "billing.invoice" has no attribute "line_total"'],
    message: 'has no attribute "line_total"',
  },
  {
    file: "python-mypy-import-untyped.log",
    failedStep: "Typecheck",
    command: "Run mypy",
    exitCode: 1,
    tools: ["mypy"],
    errorCodes: ["import-untyped"],
    failingTests: [],
    locations: [{ path: "billing/rates.py", line: 5 }],
    shows: ['error: Library stubs not installed for "requests"  [import-untyped]'],
    message: 'Library stubs not installed for "requests"',
  },
  {
    file: "python-pytest.log",
    failedStep: "Test",
    command: "Run pytest --junitxml=reports/junit.xml",
    exitCode: 1,
    tools: ["pytest"],
    errorCodes: ["AssertionError"],
    failingTests: ["tests/test_billing.py::test_invoice_total_rounds_half_up"],
    locations: [{ path: "tests/test_billing.py", line: 20 }],
    shows: ["E       AssertionError: assert Decimal('0.12') == Decimal('0.13')"],
    message: "assert Decimal('0.12') == Decimal('0.13')",
  },
  {
    file: "python-pip-no-matching-version.log",
    failedStep: "Install dependencies",
    command: "Run pip install -r requirements-dev.txt",
    exitCode: 1,
    tools: ["pip"],
    errorCodes: [],
    failingTests: [],
    locations: [],
    shows: ["ERROR: No matching distribution found for pytest==99.0.0"],
    message: "No matching distribution found for pytest==99.0.0",
  },
];

describe.each(CASES)("$file", (c) => {
  const { window, signals } = triageLog(fixture(c.file), { failedStep: c.failedStep });

  it("windows the failed step: its command, its output, its end, and nothing else", () => {
    const lines = window.split("\n");
    expect(lines[0]).toBe(c.command);
    expect(lines.at(-1)).toBe(`##[error]Process completed with exit code ${String(c.exitCode)}.`);
    for (const shown of c.shows) expect(window).toContain(shown);
    expect(lines.length).toBeLessThanOrEqual(MAX_WINDOW_LINES);
    // The step's header (shell, env) and what follows the step (post-job cleanup) stay out.
    for (const noise of [
      "shell: /usr/bin/bash",
      "LD_LIBRARY_PATH",
      "Post job cleanup",
      "Cleaning up orphan processes",
    ]) {
      expect(window).not.toContain(noise);
    }
  });

  it("parses the signals", () => {
    expect(signals).toMatchObject({
      failedStep: c.failedStep,
      exitCode: c.exitCode,
      tools: c.tools,
      errorCodes: c.errorCodes,
      failingTests: c.failingTests,
    });
    expect(signals.locations).toEqual(expect.arrayContaining(c.locations));
    expect(signals.diagnostics.map((d) => d.message).join("\n")).toContain(c.message);
  });
});

describe("node-vitest.log's messages", () => {
  // Vitest interleaves info lines ("Isolate … workers spawned") into its failure blocks.
  it("takes each failed test's assertion, not the info line printed in between", () => {
    const { signals } = triageLog(fixture("node-vitest.log"), { failedStep: "Test" });

    expect(signals.diagnostics.map((d) => d.message)).toEqual([
      "AssertionError: expected '$13.50' to be '$12.50' // Object.is equality",
      "AssertionError: expected '$1,234,568.89' to be '$1,234,567.89' // Object.is equality",
      "AssertionError: expected '-$3.50' to be '-$2.50' // Object.is equality",
      "AssertionError: expected [ '2 x MUG  $25.00', …(2) ] to deeply equal [ '2 x MUG  $25.00', …(2) ]",
      "AssertionError: expected [ '2 x MUG  $25.00', …(3) ] to deeply equal [ '2 x MUG  $25.00', …(3) ]",
    ]);
  });
});

describe("node-jest-local.txt (Jest's own output, no Actions framing)", () => {
  const { window, signals } = triageLog(fixture("node-jest-local.txt"));

  it("keeps the whole output as the window, without its colour codes", () => {
    expect(window).toContain("● formatCents › formats dollars and cents");
    expect(window).toContain('> 6 |     expect(formatCents(1250)).toBe("$12.50");');
    expect(window).not.toContain("\u001b");
  });

  it("parses Jest's failing tests and where they failed", () => {
    expect(signals).toMatchObject({
      tools: ["jest"],
      exitCode: null,
      failedStep: null,
      failingTests: [
        "test/money.test.js > formatCents › formats dollars and cents",
        "test/money.test.js > formatCents › formats refunds as negative amounts",
        "test/money.test.js > formatCents › rejects fractions of a cent",
      ],
    });
    expect(signals.locations).toEqual([
      { path: "test/money.test.js", line: 6, column: 31 },
      { path: "test/money.test.js", line: 10, column: 31 },
      { path: "test/money.test.js", line: 14, column: 36 },
    ]);
  });
});

describe("failedStepLog", () => {
  const T = "2026-09-28T23:22:10.1102345Z ";

  it("takes the failed step's command and output, not its header or what follows it", () => {
    const raw = [
      `${T}##[group]Run npm ci`,
      `${T}npm ci`,
      `${T}##[endgroup]`,
      `${T}added 3 packages`,
      `${T}##[group]Run npm test`,
      `${T}npm test`,
      `${T}shell: /usr/bin/bash -e {0}`,
      `${T}##[endgroup]`,
      `${T}Error: boom`,
      `${T}##[error]Process completed with exit code 1.`,
      `${T}Post job cleanup.`,
    ].join("\n");

    expect(failedStepLog(raw)).toBe(
      ["Run npm test", `${T}Error: boom`, `${T}##[error]Process completed with exit code 1.`].join(
        "\n",
      ),
    );
  });

  it("keeps groups a step opens inside its own output", () => {
    const raw = [
      `${T}##[group]Run ./build.sh`,
      `${T}##[endgroup]`,
      `${T}##[group]Compiling`,
      `${T}error: failed`,
      `${T}##[endgroup]`,
      `${T}##[error]Process completed with exit code 1.`,
    ].join("\n");

    expect(failedStepLog(raw)).toContain(`${T}error: failed`);
  });

  it("falls back to everything up to the error, or the whole log", () => {
    expect(failedStepLog("setup\nError: boom\n##[error]exit 1\nafter")).toBe(
      "setup\nError: boom\n##[error]exit 1",
    );
    expect(failedStepLog("no markers at all\nError: boom")).toBe("no markers at all\nError: boom");
  });
});

describe("extractErrorWindow", () => {
  it("keeps a step that fits whole", () => {
    const text = "Run x\nError: boom\n##[error]Process completed with exit code 1.";
    expect(extractErrorWindow(text)).toBe(text);
  });

  it("cuts a long step to the lines around its errors and its end, marking what it left out", () => {
    const lines = Array.from({ length: 2_000 }, (_, i) => `output line ${String(i)}`);
    lines[0] = "Run npm test";
    lines[400] = "Error: the first failure";
    lines[1_200] = "Traceback (most recent call last):";
    lines[1_999] = "##[error]Process completed with exit code 1.";

    const window = extractErrorWindow(lines.join("\n"));

    const kept = window.split("\n");
    expect(kept.length).toBeLessThanOrEqual(MAX_WINDOW_LINES);
    expect(kept[0]).toBe("Run npm test");
    for (const line of [
      "Error: the first failure",
      "output line 399",
      "output line 405",
      "Traceback (most recent call last):",
      "##[error]Process completed with exit code 1.",
      "output line 1998",
    ]) {
      expect(kept).toContain(line);
    }
    expect(window).toMatch(/… \d+ lines omitted …/);
    expect(kept).not.toContain("output line 800");
  });
});

describe("extractSignals", () => {
  it("makes paths repo-relative and POSIX, from Linux and Windows runners", () => {
    const signals = extractSignals(
      [
        "/home/runner/work/app/app/src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
        "D:\\a\\app\\app\\src\\b.ts(7,1): error TS1005: ';' expected.",
        './src/c.py:9: error: Name "x" is not defined  [name-defined]',
      ].join("\n"),
    );

    expect(signals.locations).toEqual([
      { path: "src/a.ts", line: 3, column: 5 },
      { path: "src/b.ts", line: 7, column: 1 },
      { path: "src/c.py", line: 9 },
    ]);
    expect(signals.tools).toEqual(["tsc", "mypy"]);
  });

  it("keeps ESLint warnings apart from errors", () => {
    const signals = extractSignals(
      [
        "/w/src/x.ts",
        "  1:1  warning  Unexpected console statement  no-console",
        "  2:3  error    'y' is not defined  no-undef",
      ].join("\n"),
    );
    expect(signals.diagnostics.map((d) => [d.severity, d.code])).toEqual([
      ["warning", "no-console"],
      ["error", "no-undef"],
    ]);
  });

  it("caps and de-duplicates what it collects", () => {
    const line = (i: number) => `src/f${String(i % 80)}.ts(1,1): error TS2322: Type mismatch.`;
    const signals = extractSignals(Array.from({ length: 500 }, (_, i) => line(i)).join("\n"));

    expect(signals.diagnostics.length).toBe(50);
    expect(signals.locations.length).toBe(50);
    expect(signals.errorCodes).toEqual(["TS2322"]);
  });

  it("finds nothing in output it doesn't recognize, but still the exit code", () => {
    expect(
      extractSignals("make: *** [all] Error 2\n##[error]Process completed with exit code 2."),
    ).toEqual({
      failedStep: null,
      exitCode: 2,
      tools: [],
      diagnostics: [],
      failingTests: [],
      locations: [],
      errorCodes: [],
    });
  });
});

describe("extractSignals: the tools' other output forms", () => {
  it("reads ruff's concise format, and ignores a code-looking line that doesn't point at a file", () => {
    const signals = extractSignals(
      [
        "billing/format.py:6:26: F821 Undefined name `Decimal`",
        "PR42 merged into main",
        "next line",
        "E501 Line too long (120 > 100)",
        "",
        " --> billing/invoice.py:9:101",
      ].join("\n"),
    );

    expect(signals.diagnostics).toEqual([
      {
        tool: "ruff",
        severity: "error",
        code: "F821",
        message: "Undefined name `Decimal`",
        path: "billing/format.py",
        line: 6,
        column: 26,
      },
      {
        tool: "ruff",
        severity: "error",
        code: "E501",
        message: "Line too long (120 > 100)",
        path: "billing/invoice.py",
        line: 9,
        column: 101,
      },
    ]);
  });

  it("reads a tsc error that has no location (a configuration error)", () => {
    expect(
      extractSignals("error TS5023: Unknown compiler option 'strictest'.").diagnostics,
    ).toEqual([
      {
        tool: "tsc",
        severity: "error",
        code: "TS5023",
        message: "Unknown compiler option 'strictest'.",
      },
    ]);
  });

  it("reads a Vitest file that failed to load, not just failed tests", () => {
    const signals = extractSignals(
      [
        " FAIL  test/receipt.test.ts [ test/receipt.test.ts ]",
        "Error: Failed to load url ./cart (resolved id: ./cart)",
      ].join("\n"),
    );
    expect(signals.failingTests).toEqual(["test/receipt.test.ts"]);
    expect(signals.diagnostics[0]?.message).toBe(
      "Error: Failed to load url ./cart (resolved id: ./cart)",
    );
  });

  it("stops waiting for a failed test's message when none follows", () => {
    const signals = extractSignals(
      [
        " FAIL  test/a.test.ts > a > b",
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
        "Error: printed much later, by something else",
      ].join("\n"),
    );
    expect(signals.failingTests).toEqual(["test/a.test.ts > a > b"]);
    expect(signals.diagnostics).toEqual([]);
  });

  it("reads pytest's summary lines with and without a message, and collection errors", () => {
    const signals = extractSignals(
      [
        "============================= test session starts ==============================",
        "FAILED tests/test_a.py::test_one",
        "ERROR tests/test_rates.py - ModuleNotFoundError: No module named 'requests'",
      ].join("\n"),
    );
    expect(signals.failingTests).toEqual(["tests/test_a.py::test_one", "tests/test_rates.py"]);
    expect(signals.diagnostics).toEqual([
      {
        tool: "pytest",
        severity: "error",
        code: "ModuleNotFoundError",
        message: "ModuleNotFoundError: No module named 'requests'",
      },
    ]);
  });

  it("reads an npm error code even when npm printed no message for it", () => {
    expect(extractSignals("npm error code E404").diagnostics).toEqual([
      { tool: "npm", severity: "error", code: "E404", message: "E404" },
    ]);
  });

  it("counts a failing test and a location once, however often they're printed", () => {
    const signals = extractSignals(
      [
        "FAILED tests/test_a.py::test_one - AssertionError",
        "FAILED tests/test_a.py::test_one - AssertionError",
        "src/a.ts(1,1): error TS2322: Type mismatch.",
        "src/a.ts(1,1): error TS2345: Argument mismatch.",
        ...Array.from({ length: 60 }, (_, i) => `FAILED tests/test_b.py::test_${String(i)}`),
      ].join("\n"),
    );
    expect(signals.failingTests).toHaveLength(50);
    expect(signals.failingTests.filter((id) => id === "tests/test_a.py::test_one")).toHaveLength(1);
    expect(signals.locations).toEqual([{ path: "src/a.ts", line: 1, column: 1 }]);
  });
});

describe("failedStepLog and extractErrorWindow edge cases", () => {
  it("takes a step's output from right after its command when GitHub closed no header group", () => {
    expect(
      failedStepLog(
        "##[group]Run make\nmake: *** Error 2\n##[error]Process completed with exit code 2.",
      ),
    ).toBe("Run make\nmake: *** Error 2\n##[error]Process completed with exit code 2.");
  });

  it("stops adding failures to a long window once the next one no longer fits", () => {
    const lines = Array.from({ length: 5_000 }, (_, i) =>
      i % 5 === 0 ? `Error: failure ${String(i)}` : `line ${String(i)}`,
    );

    const window = extractErrorWindow(lines.join("\n"));

    expect(window.split("\n").length).toBeLessThanOrEqual(MAX_WINDOW_LINES);
    expect(window).toContain("Error: failure 0");
    expect(window).not.toContain("Error: failure 2500");
    expect(window).toContain(lines.at(-1));
  });
});

describe("triageLog", () => {
  it("redacts before windowing and parsing: secrets never reach the window or the signals", () => {
    const token = "gh" + "p_" + "Qw7".repeat(12);
    const raw = [
      "##[group]Run npm test",
      "##[endgroup]",
      `Error: push to https://${token}@github.com/o/r rejected`,
      "##[error]Process completed with exit code 1.",
    ].join("\n");

    const result = triageLog(raw, { failedStep: "Test" });

    expect(JSON.stringify(result)).not.toContain(token);
    expect(result.window).toContain("https://[redacted:url-credentials]@github.com/o/r");
    expect(result.redactions).toEqual({ "url-credentials": 1 });
  });
});
