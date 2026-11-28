// Speed budgets for the static checks (Phase 3 security review, H2). In the `perf` project, which
// runs after the parallel suite so other test files can't eat the budget.
import { describe, expect, it } from "vitest";
import { add } from "../../fixtures/types";
import { buildChange, checkChanges, effectivePolicy, type ChangeInput } from "../index";

const EDITABLE = { mode: "may_edit_tests" } as const;

function check(changes: ChangeInput[]) {
  return checkChanges(
    changes.map(buildChange),
    effectivePolicy({ repo: { tests: EDITABLE } }).policy,
  );
}

describe("Phase 3 security review", () => {
  it("H2: stays fast on inputs that were quadratic", () => {
    const started = Date.now();
    // Sized so a quadratic regression blows the budget even under coverage instrumentation.
    check([add("tests/test_blank.py", "\n".repeat(50_000))]);
    check([add("src/a.test.ts", "const a = 1\n".repeat(4_000))]);
    check([add("src/b.test.ts", "expect(".repeat(4_000))]);
    check([add("src/c.test.ts", `const {${" skip,".repeat(5_000)}`)]);

    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
