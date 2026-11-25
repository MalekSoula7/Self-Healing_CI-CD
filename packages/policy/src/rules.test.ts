// SPEC §8.2–8.3: the rules schema, its defaults and caps, and the invariants as code. Written
// before the implementation.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  HEALABLE_CATEGORIES,
  INVARIANTS,
  INVARIANT_PATHS,
  LIMIT_CAPS,
  globSchema,
  policyLayerSchema,
  policyRulesSchema,
  type PolicyRules,
} from "./index";

describe("policyRulesSchema", () => {
  it("fills every default from an empty policy", () => {
    const policy: PolicyRules = policyRulesSchema.parse({});

    expect(policy).toEqual(DEFAULT_POLICY);
    expect(policy).toMatchObject({
      paths: {
        deny: [
          "infra/**",
          "terraform/**",
          "**/migrations/**",
          "**/Dockerfile*",
          "**/docker-compose*",
        ],
      },
      protectedConfigs: true,
      tests: { mode: "source_only", forbidSkips: true, forbidAssertionReduction: true },
      suppressions: { forbid: true },
      dependencies: { mode: "frozen", allowNew: false },
      limits: {
        maxFilesChanged: 5,
        maxLinesChanged: 150,
        maxAttemptsPerFailure: 2,
        maxIterationsPerAttempt: 10,
        maxModelTokensPerAttempt: 300_000,
        maxWallClockMinutes: 25,
      },
      scope: {
        branches: { include: ["**"], exclude: [] },
        workflows: { include: ["**"], exclude: [] },
        categories: ["compile", "typecheck", "lint", "test", "build"],
        retryBeforeHeal: true,
      },
      review: { requestCommitAuthor: true, draftBelowConfidence: "low" },
      customRules: [],
    });
    expect(policy.paths.allow).toBeUndefined();
  });

  it("protects tests, snapshots and test data by default, for JS/TS and Python", () => {
    const globs = DEFAULT_POLICY.tests.testGlobs;

    for (const expected of [
      "**/*.test.ts",
      "**/*.spec.tsx",
      "**/__tests__/**",
      "**/test_*.py",
      "**/*_test.py",
      "**/conftest.py",
      "**/__snapshots__/**",
      "**/*.snap",
      "**/fixtures/**",
      "**/testdata/**",
    ]) {
      expect(globs).toContain(expected);
    }
  });

  it("keeps what a full policy sets, filling only what it leaves out", () => {
    const policy = policyRulesSchema.parse({
      paths: { deny: ["src/payments/**"], allow: ["src/**"] },
      tests: { mode: "may_edit_tests" },
      limits: { maxFilesChanged: 3 },
      scope: { categories: ["test", "lint"] },
    });

    expect(policy.paths).toEqual({ deny: ["src/payments/**"], allow: ["src/**"] });
    expect(policy.tests.mode).toBe("may_edit_tests");
    expect(policy.tests.forbidSkips).toBe(true);
    expect(policy.limits).toEqual({ ...DEFAULT_POLICY.limits, maxFilesChanged: 3 });
    expect(policy.scope.categories).toEqual(["test", "lint"]);
  });

  it("caps every limit (INV-CAPS): no policy can lift a plan maximum", () => {
    for (const [name, cap] of Object.entries(LIMIT_CAPS)) {
      expect(policyRulesSchema.safeParse({ limits: { [name]: cap } }).success).toBe(true);
      expect(policyRulesSchema.safeParse({ limits: { [name]: cap + 1 } }).success).toBe(false);
      expect(policyRulesSchema.safeParse({ limits: { [name]: 0 } }).success).toBe(false);
      expect(policyRulesSchema.safeParse({ limits: { [name]: 1.5 } }).success).toBe(false);
    }
    // The healer job times out at 30 minutes (SPEC §5.3): an attempt must end before.
    expect(LIMIT_CAPS.maxWallClockMinutes).toBe(25);
  });

  it("only lets healable categories in scope (SPEC §6.1)", () => {
    expect(HEALABLE_CATEGORIES).toEqual([
      "compile",
      "typecheck",
      "lint",
      "test",
      "dependency",
      "build",
    ]);
    for (const category of ["infra", "config", "flaky", "unknown", "deploy"]) {
      expect(policyRulesSchema.safeParse({ scope: { categories: [category] } }).success).toBe(
        false,
      );
    }
  });

  it.each([
    ["an absolute path", "/etc/**"],
    ["a parent directory", "src/../secrets/**"],
    ["a backslash", "src\\**"],
    ["a leading ./", "./src/**"],
    ["an empty glob", ""],
    ["a control character", "src/\n**"],
    ["an overlong glob", `${"a/".repeat(200)}**`],
  ])("refuses a glob with %s", (_label, glob) => {
    expect(policyRulesSchema.safeParse({ paths: { deny: [glob] } }).success).toBe(false);
  });

  it("refuses unknown keys and wrong types: a typo must not silently loosen a rule", () => {
    for (const input of [
      { paths: { denny: ["x/**"] } },
      { protectedConfig: false },
      { tests: { mode: "anything_goes" } },
      { dependencies: { mode: "major" } },
      { review: { draftBelowConfidence: "high" } },
      { suppressions: { forbid: "no" } },
    ]) {
      expect(policyRulesSchema.safeParse(input).success).toBe(false);
    }
  });

  it("bounds list sizes", () => {
    const tooMany = Array.from({ length: 201 }, (_, i) => `dir${String(i)}/**`);
    expect(policyRulesSchema.safeParse({ paths: { deny: tooMany } }).success).toBe(false);
  });
});

describe("custom rules (SPEC §8.7)", () => {
  const codeRule = {
    id: "CR-1",
    text: "Don't touch the payments module.",
    enforcement: "code",
    compiled: { paths: { deny: ["src/payments/**"] } },
  };
  const judgeRule = {
    id: "CR-2",
    text: "Never change public API signatures.",
    enforcement: "judge",
  };

  it("accepts a compiled code rule and a judge rule", () => {
    const policy = policyRulesSchema.parse({ customRules: [codeRule, judgeRule] });

    expect(policy.customRules).toEqual([codeRule, judgeRule]);
  });

  it.each([
    ["a code rule without its compiled form", { ...codeRule, compiled: undefined }],
    [
      "a judge rule with a compiled form",
      { ...judgeRule, compiled: { suppressions: { forbid: true } } },
    ],
    ["a malformed ID", { ...judgeRule, id: "rule-1" }],
    ["empty text", { ...judgeRule, text: "" }],
    [
      "a compiled form that nests custom rules",
      { ...codeRule, compiled: { customRules: [judgeRule] } },
    ],
  ])("refuses %s", (_label, rule) => {
    expect(policyRulesSchema.safeParse({ customRules: [rule] }).success).toBe(false);
  });

  it("refuses two rules with the same ID", () => {
    expect(policyRulesSchema.safeParse({ customRules: [judgeRule, judgeRule] }).success).toBe(
      false,
    );
  });
});

describe("policyLayerSchema", () => {
  it("keeps exactly what a layer sets, no defaults (P3.3 merges set values only)", () => {
    expect(policyLayerSchema.parse({})).toEqual({});
    expect(policyLayerSchema.parse({ limits: { maxFilesChanged: 2 } })).toEqual({
      limits: { maxFilesChanged: 2 },
    });
  });

  it("validates a layer as strictly as a whole policy", () => {
    expect(policyLayerSchema.safeParse({ limits: { maxFilesChanged: 999 } }).success).toBe(false);
    expect(policyLayerSchema.safeParse({ paths: { deny: ["../x"] } }).success).toBe(false);
    expect(policyLayerSchema.safeParse({ unknown: true }).success).toBe(false);
  });

  it("refuses a glob whose braces expand past the matcher's bound", () => {
    const tooMany = "{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}";

    expect(globSchema.safeParse(tooMany).success).toBe(false);
    expect(globSchema.safeParse("src/{a,b}/**").success).toBe(true);
  });
});

describe("invariants (SPEC §8.2)", () => {
  it("lists every invariant once, with a description", () => {
    expect(INVARIANTS.map((invariant) => invariant.id)).toEqual([
      "INV-GITHUB-DIR",
      "INV-PATH",
      "INV-SECRETS",
      "INV-FILE-TYPES",
      "INV-TEST-DELETE",
      "INV-BRANCH",
      "INV-FORKS",
      "INV-CAPS",
    ]);
    for (const invariant of INVARIANTS) expect(invariant.description.length).toBeGreaterThan(10);
  });

  it("names the paths no change may touch, whatever the policy", () => {
    expect(INVARIANT_PATHS["INV-GITHUB-DIR"]).toEqual([
      ".github/**",
      "**/action.yml",
      "**/action.yaml",
    ]);
    expect(INVARIANT_PATHS["INV-SECRETS"]).toEqual(
      expect.arrayContaining([
        "**/.env*",
        "**/*.pem",
        "**/secrets/**",
        "**/.npmrc",
        "**/id_{rsa,dsa,ecdsa,ed25519}*",
      ]),
    );
  });

  it("can't be changed at runtime", () => {
    expect(Object.isFrozen(INVARIANTS)).toBe(true);
    expect(Object.isFrozen(INVARIANT_PATHS["INV-SECRETS"])).toBe(true);
    expect(Object.isFrozen(DEFAULT_POLICY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_POLICY.paths.deny)).toBe(true);
  });
});
