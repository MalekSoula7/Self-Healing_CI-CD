// agent-core bounds what triage produces (TRIAGE_LIMITS); packages/db validates what it stores
// (jobTriageInputSchema). The two must agree: whatever a log contains, its triage is storable.
// (Phase 2 security review H1: an oversized field threw, retried the job, and blocked the
// failure's other jobs.)
import { triageLog } from "@pipeheal/agent-core";
import { jobTriageInputSchema } from "@pipeheal/db";
import { describe, expect, it } from "vitest";

function step(body: string): string {
  return `##[group]Run x\n##[endgroup]\n${body}\n##[error]Process completed with exit code 1.`;
}

const long = (n: number, c = "a") => c.repeat(n);

const ADVERSARIAL: [string, string, string | null][] = [
  [
    "300 lines of 2,000 characters",
    Array.from({ length: 300 }, (_, i) => `${long(1_990, "x")}${String(i)}`).join("\n"),
    "x",
  ],
  ["a 1,500-character pytest ID", `FAILED tests/${long(1_500)}.py::test_x`, "x"],
  ["a line number above 2^53", "src/a.py:99999999999999999999: error: boom  [attr-defined]", "x"],
  ["a 700-character path", `src/${long(700, "b")}.py:1: error: boom  [x]`, "x"],
  ["a 300-character step name", "plain", long(300, "s")],
  ["a huge tsc code", `src/a.ts(1,1): error TS${long(200, "9")}: boom`, "x"],
  [
    "a long ESLint rule",
    `/home/runner/work/r/r/src/a.ts\n  1:1  error  boom  ${long(300, "r")}`,
    "x",
  ],
  [
    "many long Vitest failures",
    Array.from(
      { length: 80 },
      (_, i) => ` FAIL  test/${long(400)}${String(i)}.test.ts > ${long(900)}`,
    ).join("\n"),
    "x",
  ],
];

describe("triage output always fits what's stored", () => {
  it.each(ADVERSARIAL)("%s", (_label, body, failedStep) => {
    const { window, signals } = triageLog(step(body), { failedStep });

    const parsed = jobTriageInputSchema.safeParse({ errorWindow: window, signals });

    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join("."))).toEqual(
      [],
    );
  });
});
