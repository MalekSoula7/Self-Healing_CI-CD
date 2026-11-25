// SPEC §6.2 step 7: the recent changes given to triage and the healer, truncated to a token
// budget, files named in the signals first. Written before the implementation.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECENT_CHANGES_BUDGET,
  estimateTokens,
  renderRecentChanges,
  selectRecentChanges,
  signalPaths,
  type ChangedFileInput,
  type ComparisonInput,
} from "./index";

// Built at runtime: nothing secret-shaped is committed.
const PLANTED_TOKEN = "gh" + "p_" + "Kd7".repeat(12);

function hunk(start: number, lines: number, label = "line"): string {
  const body = Array.from({ length: lines }, (_, i) => `+${label} ${String(start + i)}`);
  return [`@@ -${String(start)},0 +${String(start)},${String(lines)} @@`, ...body].join("\n");
}

function file(path: string, patch: string | null, overrides: Partial<ChangedFileInput> = {}) {
  const added = patch === null ? 0 : patch.split("\n").filter((l) => l.startsWith("+")).length;
  return {
    path,
    previousPath: null,
    status: "modified",
    additions: added,
    deletions: 0,
    patch,
    ...overrides,
  } satisfies ChangedFileInput;
}

function comparison(
  files: ChangedFileInput[],
  overrides: Partial<ComparisonInput> = {},
): ComparisonInput {
  return {
    totalCommits: 2,
    commitsTruncated: false,
    filesTruncated: false,
    commits: [
      { sha: "1".repeat(40), message: "feat: receipts\n\nLonger body.", authorLogin: "dev" },
      { sha: "2".repeat(40), message: "fix: rename lineTotal", authorLogin: null },
    ],
    files,
    ...overrides,
  };
}

describe("estimateTokens", () => {
  it("errs on the high side: one token per 3.5 characters, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("a".repeat(35))).toBe(10);
    expect(estimateTokens("a".repeat(36))).toBe(11);
  });
});

describe("signalPaths", () => {
  it("collects the files the signals point at, in order, once each", () => {
    // Shaped like agent-core's Signals and the stored copy of them.
    const signals = {
      locations: [
        { path: "src/receipt.ts", line: 1 },
        { path: "src/cart.ts", line: 4 },
        { path: "src/receipt.ts", line: 9 },
      ],
      diagnostics: [
        { tool: "tsc", severity: "error", message: "x", path: "src/money.ts" },
        { tool: "npm", severity: "error", message: "no path" },
      ],
      failingTests: [
        "test/money.test.ts > money > rounds",
        "tests/test_billing.py::test_total",
        "a test name without a file",
      ],
    };

    expect(signalPaths(signals)).toEqual([
      "src/receipt.ts",
      "src/cart.ts",
      "src/money.ts",
      "test/money.test.ts",
      "tests/test_billing.py",
    ]);
  });
});

describe("selectRecentChanges", () => {
  it("keeps everything when it fits: commit subjects, every file with its full patch", () => {
    const changes = selectRecentChanges(
      comparison([file("src/receipt.ts", hunk(1, 3)), file("README.md", hunk(10, 2))]),
      { priorityPaths: ["src/receipt.ts"] },
    );

    expect(changes.commits).toEqual([
      { sha: "1".repeat(40), subject: "feat: receipts", authorLogin: "dev" },
      { sha: "2".repeat(40), subject: "fix: rename lineTotal", authorLogin: null },
    ]);
    expect(changes.omittedCommits).toBe(0);
    expect(changes.files.map((f) => [f.path, f.priority, f.patchState])).toEqual([
      ["src/receipt.ts", true, "full"],
      ["README.md", false, "full"],
    ]);
    expect(changes.files[0]?.patch).toBe(hunk(1, 3));
    expect(changes.omittedFiles).toBe(0);
    expect(changes.totalFiles).toBe(2);
    expect(changes.githubTruncated).toBe(false);
    expect(changes.tokenBudget).toBe(DEFAULT_RECENT_CHANGES_BUDGET);
  });

  it("puts files named in the signals first, then source files, then lockfiles and build output", () => {
    const changes = selectRecentChanges(
      comparison([
        file("pnpm-lock.yaml", hunk(1, 2)),
        file("dist/app.min.js", hunk(1, 1)),
        file("src/big.ts", hunk(1, 9)),
        file("src/small.ts", hunk(1, 1)),
        file("src/receipt.ts", hunk(1, 20)),
      ]),
      { priorityPaths: ["src/receipt.ts"] },
    );

    expect(changes.files.map((f) => f.path)).toEqual([
      "src/receipt.ts",
      "src/small.ts",
      "src/big.ts",
      "dist/app.min.js",
      "pnpm-lock.yaml",
    ]);
  });

  it("counts a renamed file as named when the signals use its old path", () => {
    const changes = selectRecentChanges(
      comparison([
        file("src/other.ts", hunk(1, 1)),
        file("src/new-name.ts", hunk(1, 4), { status: "renamed", previousPath: "src/old-name.ts" }),
      ]),
      { priorityPaths: ["src/old-name.ts"] },
    );

    expect(changes.files[0]).toMatchObject({
      path: "src/new-name.ts",
      previousPath: "src/old-name.ts",
      priority: true,
    });
  });

  it("cuts a named file's patch at a hunk boundary when it doesn't all fit", () => {
    const patch = [hunk(1, 30, "a"), hunk(100, 30, "b"), hunk(200, 400, "c")].join("\n");
    const changes = selectRecentChanges(comparison([file("src/receipt.ts", patch)]), {
      priorityPaths: ["src/receipt.ts"],
      tokenBudget: 700,
    });

    const [kept] = changes.files;
    expect(kept?.patchState).toBe("partial");
    expect(kept?.patch?.startsWith(`${hunk(1, 30, "a")}\n${hunk(100, 30, "b")}\n`)).toBe(true);
    expect(kept?.patch).not.toContain("+c ");
    expect(kept?.patch).toMatch(/… \d+ more lines of this diff omitted$/);
  });

  it("keeps the first lines of one huge hunk of a named file", () => {
    const changes = selectRecentChanges(comparison([file("src/receipt.ts", hunk(1, 5_000))]), {
      priorityPaths: ["src/receipt.ts"],
      tokenBudget: 600,
    });

    const [kept] = changes.files;
    expect(kept?.patchState).toBe("partial");
    expect(kept?.patch?.startsWith("@@ -1,0 +1,5000 @@\n+line 1\n+line 2\n")).toBe(true);
    expect(changes.estimatedTokens).toBeLessThanOrEqual(600);
  });

  it("lists other files without their diff once the budget is spent", () => {
    const changes = selectRecentChanges(
      comparison([
        file("src/receipt.ts", hunk(1, 60)),
        file("src/other.ts", hunk(1, 60)),
        file("logo.png", null, { status: "added" }),
      ]),
      { priorityPaths: ["src/receipt.ts"], tokenBudget: 300 },
    );

    expect(changes.files.map((f) => [f.path, f.patchState, f.patch])).toEqual([
      ["src/receipt.ts", "full", hunk(1, 60)],
      ["src/other.ts", "omitted", null],
      ["logo.png", "none", null],
    ]);
  });

  it("drops whole files (counting them) when even their names don't fit", () => {
    const files = Array.from({ length: 300 }, (_, i) =>
      file(`src/generated/module-${String(i).padStart(3, "0")}.ts`, hunk(1, 2)),
    );
    const changes = selectRecentChanges(comparison(files, { filesTruncated: true }), {
      tokenBudget: 1_000,
    });

    expect(changes.files.length).toBeGreaterThan(0);
    expect(changes.files.length + changes.omittedFiles).toBe(300);
    expect(changes.omittedFiles).toBeGreaterThan(0);
    expect(changes.githubTruncated).toBe(true);
    expect(changes.estimatedTokens).toBeLessThanOrEqual(1_000);
  });

  it("keeps commit subjects within a fifth of the budget and counts the rest", () => {
    const commits = Array.from({ length: 250 }, (_, i) => ({
      sha: i.toString(16).padStart(40, "0"),
      message: `chore: commit number ${String(i)} with a fairly long subject line`,
      authorLogin: "dev",
    }));
    const changes = selectRecentChanges(
      comparison([file("src/a.ts", hunk(1, 2))], {
        commits,
        totalCommits: 400,
        commitsTruncated: true,
      }),
      { tokenBudget: 2_000 },
    );

    expect(changes.commits.length).toBeGreaterThan(0);
    expect(changes.commits.length).toBeLessThan(250);
    expect(changes.commits.length + changes.omittedCommits).toBe(400);
    expect(changes.totalCommits).toBe(400);
    expect(changes.githubTruncated).toBe(true);
    expect(changes.files[0]?.patchState).toBe("full");
  });

  it("caps long subjects", () => {
    const changes = selectRecentChanges(
      comparison([], {
        commits: [{ sha: "3".repeat(40), message: "x".repeat(500), authorLogin: null }],
      }),
    );

    expect(changes.commits[0]?.subject).toHaveLength(200);
  });

  it("redacts secrets in diffs and commit messages before anything else sees them", () => {
    const patch = `@@ -1,0 +1,2 @@\n+const token = "${PLANTED_TOKEN}";\n+export {};`;
    const changes = selectRecentChanges(
      comparison([file("src/config.ts", patch)], {
        commits: [
          { sha: "4".repeat(40), message: `chore: rotate ${PLANTED_TOKEN}`, authorLogin: null },
        ],
      }),
    );

    const rendered = renderRecentChanges(changes);
    expect(rendered).not.toContain(PLANTED_TOKEN);
    expect(JSON.stringify(changes)).not.toContain(PLANTED_TOKEN);
    expect(rendered).toContain("[redacted:");
    expect(Object.values(changes.redactions).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2);
  });

  it("never exceeds its budget, whatever the budget", () => {
    const input = comparison([
      file("src/receipt.ts", [hunk(1, 80), hunk(200, 80)].join("\n")),
      file("src/cart.ts", hunk(1, 150)),
      file("package-lock.json", hunk(1, 900)),
      ...Array.from({ length: 40 }, (_, i) => file(`docs/page-${String(i)}.md`, hunk(1, 5))),
    ]);
    for (const tokenBudget of [150, 300, 700, 1_500, 4_000, 12_000, 50_000]) {
      const changes = selectRecentChanges(input, {
        priorityPaths: ["src/receipt.ts"],
        tokenBudget,
      });
      expect(changes.estimatedTokens).toBeLessThanOrEqual(tokenBudget);
      expect(changes.estimatedTokens).toBe(estimateTokens(renderRecentChanges(changes)));
    }
  });

  it("is deterministic", () => {
    const input = comparison([file("b.ts", hunk(1, 3)), file("a.ts", hunk(1, 3))]);
    expect(selectRecentChanges(input)).toEqual(selectRecentChanges(input));
  });
});

describe("renderRecentChanges", () => {
  it("renders commits, then each file with its status, line counts and diff", () => {
    const changes = selectRecentChanges(
      comparison(
        [
          file("src/receipt.ts", hunk(1, 2)),
          file("src/new.ts", hunk(1, 1), { status: "renamed", previousPath: "src/old.ts" }),
          file("logo.png", null, { status: "added" }),
        ],
        { totalCommits: 3 },
      ),
      { priorityPaths: ["src/receipt.ts"] },
    );

    expect(renderRecentChanges(changes)).toBe(
      [
        "Commits (2 of 3):",
        `- 1111111 feat: receipts (dev)`,
        `- 2222222 fix: rename lineTotal`,
        "- … 1 more commit not listed",
        "Changed files (3 of 3):",
        "modified src/receipt.ts (+2 -0) [named in the failure]",
        hunk(1, 2),
        "renamed src/old.ts -> src/new.ts (+1 -0)",
        hunk(1, 1),
        "added logo.png (+0 -0) (no text diff)",
      ].join("\n"),
    );
  });

  it("says when diffs or files were left out", () => {
    const files = [
      file("src/a.ts", hunk(1, 300)),
      ...Array.from({ length: 50 }, (_, i) => file(`f${String(i)}.ts`, hunk(1, 1))),
    ];
    const rendered = renderRecentChanges(
      selectRecentChanges(comparison(files), { tokenBudget: 400 }),
    );

    expect(rendered).toMatch(/\(diff omitted\)/);
    expect(rendered).toMatch(/… \d+ more changed files not listed$/);
  });
});
