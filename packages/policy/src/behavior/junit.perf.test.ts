// Speed budget for the JUnit reader (Phase 3 security review, M2). In the `perf` project, which
// runs after the parallel suite so other test files can't eat the budget.
import { describe, expect, it } from "vitest";
import { parseJunit } from "./junit";

describe("parseJunit performance", () => {
  it("reads a huge attribute body in linear time (security review M2)", () => {
    const started = Date.now();
    parseJunit(`<testsuite><testcase name="t" ${"a".repeat(500_000)}/></testsuite>`);

    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
