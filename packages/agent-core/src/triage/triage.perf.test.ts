// Speed budgets for triage (Phase 2 security review). In the `perf` project, which runs after the
// parallel suite so other test files can't eat the budget.
import { describe, expect, it } from "vitest";
import { triageLog } from "./index";

describe("triageLog", () => {
  // Adversarial shapes found by the Phase 2 security review (each took seconds before): a long
  // run of scheme-like characters for the URL rules, and padded ESLint rows.
  it.each([
    ["5 MB of 'a.a.a…' lines", "a.".repeat(1_000), 2_500],
    ["ESLint rows padded with spaces", `  1:1  error  x${" ".repeat(1_980)}!`, 2_500],
    ["Vitest rows with brackets", `FAIL a.ts > ${" [ x".repeat(497)}`, 2_500],
  ])("stays fast on %s", (_label, line, count) => {
    const raw = `##[group]Run x\n##[endgroup]\n${`${line}\n`.repeat(count)}##[error]Process completed with exit code 1.`;

    const started = performance.now();
    triageLog(raw, { failedStep: "x" });

    expect(performance.now() - started).toBeLessThan(1_500);
  });
});
