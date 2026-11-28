import { describe, expect, it } from "vitest";
import {
  failureFilters,
  failuresHref,
  label,
  percent,
  shortSha,
  storedRecentChanges,
  storedSignals,
} from "./failures";

const REPO = "0192b7e0-1c2d-7e3f-8a4b-5c6d7e8f9a0b";
const BEFORE = "0192b7e0-1c2d-7e3f-8a4b-5c6d7e8f9a0c";

describe("failureFilters", () => {
  it("reads the repository, status and page from the URL", () => {
    expect(failureFilters({ repo: REPO, status: "TRIAGED", before: BEFORE })).toEqual({
      repoId: REPO,
      status: "TRIAGED",
      before: BEFORE,
    });
  });

  it.each([
    [{ repo: "not-a-uuid" }],
    [{ status: "triaged" }],
    [{ status: "DROP TABLE" }],
    [{ before: "1" }],
    [{ repo: [REPO, REPO] }],
    [{}],
  ])("drops what isn't valid: %o", (params) => {
    expect(failureFilters(params)).toEqual({});
  });
});

describe("failuresHref", () => {
  it("builds the list's URL", () => {
    expect(failuresHref("acme", {})).toBe("/acme/failures");
    expect(failuresHref("acme", { repoId: REPO, status: "FLAKY", before: BEFORE })).toBe(
      `/acme/failures?repo=${REPO}&status=FLAKY&before=${BEFORE}`,
    );
  });
});

describe("stored JSON", () => {
  const signals = {
    failedStep: "Test",
    exitCode: 1,
    tools: ["vitest"],
    diagnostics: [],
    failingTests: ["test/a.test.ts > a"],
    locations: [{ path: "test/a.test.ts", line: 3 }],
    errorCodes: [],
  };

  it("reads well-formed signals and nothing else", () => {
    expect(storedSignals(signals)).toEqual(signals);
    expect(storedSignals(null)).toBeNull();
    expect(storedSignals({ ...signals, tools: "vitest" })).toBeNull();
  });

  it("reads recent changes with or without a base, and nothing else", () => {
    const none = { base: null, reason: "No green run." };
    expect(storedRecentChanges(none)).toEqual(none);
    expect(storedRecentChanges(null)).toBeNull();
    expect(storedRecentChanges({ base: null })).toBeNull();
  });
});

describe("formatting", () => {
  it("labels, shortens and rounds", () => {
    expect(label("NEEDS_HUMAN")).toBe("needs human");
    expect(shortSha("a".repeat(40))).toBe("aaaaaaa");
    expect(percent(0.954)).toBe("95%");
    expect(percent(null)).toBe("–");
  });
});
