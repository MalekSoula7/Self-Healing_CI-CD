// The pull request PipeHeal opens (SPEC §9, P5.2b): title, body and draft rule. Everything a model,
// a repository or a CI log wrote is shown literally, never as Markdown or HTML.
import type { SubmissionValidation } from "@pipeheal/db";
import { describe, expect, it } from "vitest";
import { codeBlock, inlineCode, isDraft, prBody, prTitle, type PrBodyInput } from "./body";

const validation: SubmissionValidation = {
  passed: true,
  reasons: [],
  violations: [],
  behavior: { available: true, reason: null },
  checks: [
    { name: "lint", exitCode: 0 },
    { name: "test", exitCode: 0 },
  ],
  judge: [{ ruleId: "CR-2", layer: "org-default", outcome: "passed", detail: "Only the body." }],
  draftReasons: [],
  changedFiles: 1,
  digest: "a".repeat(64),
};

const JOB = {
  workflowName: "CI",
  jobName: "check",
  failedStep: "Test",
  runUrl: "https://github.com/acme/app/actions/runs/7",
};

const input = (overrides: Partial<PrBodyInput> = {}): PrBodyInput => ({
  failure: {
    headSha: "0123456789abcdef0123456789abcdef01234567",
    category: "TEST",
    jobs: [JOB],
  },
  fix: {
    rootCause: "The total subtracted instead of adding.",
    changes: "src/cart.ts: use + instead of -.",
    verification: "The test check passes.",
    confidence: "high",
  },
  files: ["src/cart.ts"],
  failingCheck: "test",
  validation,
  tests: { after: 12, baseline: 12 },
  attempt: { attemptNo: 1, iterations: 4, model: "qwen3:14b", timelineUrl: null },
  ...overrides,
});

describe("inlineCode and codeBlock", () => {
  it("can't be closed from inside, whatever backticks the text holds", () => {
    expect(inlineCode("a`b")).toBe("`` a`b ``");
    expect(inlineCode("plain")).toBe("`plain`");
    expect(codeBlock("x\n```\n# Heading")).toBe("````text\nx\n```\n# Heading\n````");
    expect(codeBlock("x")).toBe("```text\nx\n```");
  });

  it("drops control, bidi and zero-width characters, and caps the length", () => {
    const sneaky = "a\u202Eb\u200Bc\u0007d\u2066e";

    expect(inlineCode(sneaky)).toBe("`abcde`");
    expect(inlineCode("x".repeat(500), 10)).toBe("`xxxxxxxxxx…`");
    expect(inlineCode("two\nlines")).toBe("`two lines`");
    expect(inlineCode("")).toBe("`(empty)`");
  });
});

describe("prTitle", () => {
  it("is one plain line from the model's root cause, with PipeHeal's tag", () => {
    const fix = input().fix;

    expect(prTitle(fix)).toBe("fix: The total subtracted instead of adding. [PipeHeal]");
    expect(prTitle(fix && { ...fix, rootCause: "First. Second sentence." })).toBe(
      "fix: First. [PipeHeal]",
    );
    expect(prTitle(fix && { ...fix, rootCause: `@admin ${"x".repeat(200)}\u202E` })).toMatch(
      /^fix: @\u200Badmin x+… \[PipeHeal\]$/,
    );
    expect(prTitle(null)).toBe("fix: repair the failing CI check [PipeHeal]");
  });
});

describe("prBody", () => {
  it("follows SPEC §9's sections", () => {
    const body = prBody(input());

    for (const heading of [
      "## What failed",
      "## Root cause",
      "## What changed",
      "## Verification",
      "## Rules checked",
      "## Attempt",
    ]) {
      expect(body).toContain(heading);
    }
    expect(body).toContain("`CI` / `check` / `Test` on `0123456789ab`");
    expect(body).toContain("[failed run](https://github.com/acme/app/actions/runs/7)");
    expect(body).toContain("category: test");
    expect(body).toContain("- Reproduced failure: yes (`test`)");
    expect(body).toContain("- After fix: lint ✅ test ✅");
    expect(body).toContain("- Behavioral checks: passed (12 tests, baseline 12)");
    expect(body).toContain("✅ CR-2 (AI judge)");
    expect(body).toContain("Iterations: 4 · Model: `qwen3:14b`");
    expect(body).toContain("PipeHeal never merges.");
  });

  it("shows model and repository text literally: no mentions, links, HTML or headings", () => {
    const body = prBody(
      input({
        fix: {
          rootCause: "@org/admins please merge <img src=x onerror=alert(1)> [click](https://evil)",
          changes: "```\n## Approved\n```",
          verification: "#1 fixed",
          confidence: "high",
        },
        files: ["src/[weird](x).ts"],
      }),
    );

    // Every one of them sits inside a fence or a code span.
    expect(body).toContain("```text\n@org/admins please merge <img");
    expect(body).toContain("````text\n```\n## Approved\n```\n````");
    expect(body).toContain("- `src/[weird](x).ts`");
  });

  it("only links to GitHub's own run pages", () => {
    const body = prBody(
      input({
        failure: { ...input().failure, jobs: [{ ...JOB, runUrl: "javascript:alert(1)" }] },
      }),
    );

    expect(body).not.toContain("javascript:");
    expect(body).not.toContain("[failed run]");
  });

  it("says why it is a draft, and when behavioral checks were unavailable", () => {
    const body = prBody(
      input({
        validation: {
          ...validation,
          behavior: { available: false, reason: "no JUnit report was found" },
          draftReasons: ["Behavioral checks were unavailable (no JUnit report was found)."],
        },
        tests: null,
      }),
    );

    expect(body).toContain("- Behavioral checks: unavailable (`no JUnit report was found`)");
    expect(body).toContain("## Opened as a draft");
  });

  it("names the timeline when the dashboard link is known", () => {
    const body = prBody(
      input({
        attempt: { ...input().attempt, timelineUrl: "https://app.pipeheal.dev/acme/failures/1" },
      }),
    );

    expect(body).toContain("[Full timeline](https://app.pipeheal.dev/acme/failures/1)");
  });

  it("stays within GitHub's body limit", () => {
    const long = "y".repeat(10_000);
    const body = prBody(
      input({
        fix: { rootCause: long, changes: long, verification: long, confidence: "low" },
        files: Array.from(
          { length: 50 },
          (_, index) => `src/${String(index)}/${long.slice(0, 300)}`,
        ),
      }),
    );

    expect(body.length).toBeLessThanOrEqual(60_000);
  });
});

describe("isDraft", () => {
  const fix = {
    rootCause: "x",
    changes: "y",
    verification: "z",
    confidence: "high" as "low" | "medium" | "high",
  };

  it("drafts at or below the policy's confidence threshold", () => {
    expect(isDraft({ ...fix, confidence: "low" }, validation, "low")).toBe(true);
    expect(isDraft({ ...fix, confidence: "medium" }, validation, "low")).toBe(false);
    expect(isDraft({ ...fix, confidence: "medium" }, validation, "medium")).toBe(true);
    expect(isDraft({ ...fix, confidence: "high" }, validation, "medium")).toBe(false);
    expect(isDraft({ ...fix, confidence: "low" }, validation, "never")).toBe(false);
    expect(isDraft(null, validation, "low")).toBe(true);
  });

  it("drafts whenever validation gave a reason, whatever the confidence", () => {
    expect(
      isDraft(fix, { ...validation, draftReasons: ["a file-wide suppression"] }, "never"),
    ).toBe(true);
  });
});
