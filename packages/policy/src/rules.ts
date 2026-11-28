// SPEC §8.3: what a policy can say, validated with zod. Two schemas from the same field rules:
// - policyRulesSchema: a complete policy, every missing value filled with its default;
// - policyLayerSchema: one layer (org default, repo, .pipeheal.yml) exactly as written, no
//   defaults, so the merge (P3.3) can tell a value a layer set from one it left alone.
// Both are strict: an unknown key (a typo) is an error, never silently ignored, because an ignored
// key could leave a rule looser than its author meant.
import { z } from "zod";
import { MAX_GLOB_ALTERNATIVES, compileGlob } from "./glob";
import { deepFreeze } from "./invariants";

/** SPEC §6.1's categories PipeHeal may try to heal; the others are diagnosed only. */
export const HEALABLE_CATEGORIES = [
  "compile",
  "typecheck",
  "lint",
  "test",
  "dependency",
  "build",
] as const;
export type HealableCategory = (typeof HEALABLE_CATEGORIES)[number];

/**
 * Plan maximums (INV-CAPS): no policy layer can set a limit above these. The healer job times out
 * at 30 minutes (SPEC §5.3), so an attempt must end well before.
 */
export const LIMIT_CAPS = deepFreeze({
  maxFilesChanged: 50,
  maxLinesChanged: 2_000,
  maxAttemptsPerFailure: 5,
  maxIterationsPerAttempt: 30,
  maxModelTokensPerAttempt: 2_000_000,
  maxWallClockMinutes: 25,
});
type LimitName = keyof typeof LIMIT_CAPS;

const MAX_GLOBS = 200;
const MAX_CUSTOM_RULES = 50;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * A repo-relative POSIX glob (matching semantics: glob.ts). Never absolute, never above the repo
 * root, never Windows-style: those could never match a repo path, so they'd silently do nothing.
 */
export const globSchema = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (glob) =>
      !glob.startsWith("/") &&
      !glob.startsWith("./") &&
      !glob.includes("\\") &&
      !glob.split("/").includes("..") &&
      !hasControlCharacter(glob),
    "must be a repository-relative POSIX glob (no leading /, ./, .., or backslash)",
  )
  .refine(
    (glob) => compileGlob(glob) !== null,
    `braces must expand to at most ${String(MAX_GLOB_ALTERNATIVES)} alternatives`,
  );
const globs = z.array(globSchema).max(MAX_GLOBS);

const testsMode = z.enum(["source_only", "may_edit_tests"]);
const dependencyMode = z.enum(["frozen", "patch", "minor", "any"]);
/** Open the PR as a draft when the fix's confidence is at or below this; "never" to never. */
const draftBelowConfidence = z.enum(["low", "medium", "never"]);
const categories = z.array(z.enum(HEALABLE_CATEGORIES)).max(HEALABLE_CATEGORIES.length);

const limit = (name: LimitName) => z.int().min(1).max(LIMIT_CAPS[name]);

/** Defaults (SPEC §8.3). Factories, so every parsed policy gets its own arrays. */
const DEFAULTS = {
  deny: () => [
    "infra/**",
    "terraform/**",
    "**/migrations/**",
    "**/Dockerfile*",
    "**/docker-compose*",
  ],
  testGlobs: () => [
    // JavaScript and TypeScript
    "**/*.test.js",
    "**/*.test.jsx",
    "**/*.test.ts",
    "**/*.test.tsx",
    "**/*.test.mjs",
    "**/*.test.cjs",
    "**/*.test.mts",
    "**/*.test.cts",
    "**/*.spec.js",
    "**/*.spec.jsx",
    "**/*.spec.ts",
    "**/*.spec.tsx",
    "**/*.spec.mjs",
    "**/*.spec.cjs",
    "**/*.spec.mts",
    "**/*.spec.cts",
    "**/__tests__/**",
    // Jest's default testMatch also takes files named test.ts; Mocha runs test/; Cypress
    // specs; setup files and manual mocks steer what tests see.
    "**/test.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
    // Deno/Bun cart_test.ts, RSpec-style cart_spec.ts, type tests (cart.test-d.ts), Jest
    // __fixtures__/. Storybook stories are tests only with its test runner: decided server side.
    "**/*_{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
    "**/*.{test,spec}-d.*",
    "**/__fixtures__/**",
    "**/test/**",
    "**/*.cy.*",
    "**/{vitest,jest}.setup.*",
    "**/{setupTests,setup-tests,test-setup,testSetup}.*",
    "**/__mocks__/**",
    // Python
    "**/test_*.py",
    "**/*_test.py",
    "**/conftest.py",
    // Django and unittest: app/tests.py
    "**/tests.py",
    "**/tests/**",
    // Expected outputs: protected like the tests themselves (source_only)
    "**/__snapshots__/**",
    "**/*.snap",
    "**/fixtures/**",
    "**/testdata/**",
  ],
  limits: {
    maxFilesChanged: 5,
    maxLinesChanged: 150,
    maxAttemptsPerFailure: 2,
    maxIterationsPerAttempt: 10,
    maxModelTokensPerAttempt: 300_000,
    maxWallClockMinutes: 25,
  } satisfies Record<LimitName, number>,
  categories: (): HealableCategory[] => ["compile", "typecheck", "lint", "test", "build"],
  everything: () => ["**"],
} as const;

// ---------------------------------------------------------------------------------------------
// Layers: exactly what was written.

const includeExclude = z.strictObject({ include: globs.optional(), exclude: globs.optional() });

const layerFields = {
  paths: z.strictObject({ deny: globs.optional(), allow: globs.optional() }).optional(),
  protectedConfigs: z.boolean().optional(),
  tests: z
    .strictObject({
      mode: testsMode.optional(),
      forbidSkips: z.boolean().optional(),
      forbidAssertionReduction: z.boolean().optional(),
      testGlobs: globs.optional(),
    })
    .optional(),
  suppressions: z.strictObject({ forbid: z.boolean().optional() }).optional(),
  dependencies: z
    .strictObject({ mode: dependencyMode.optional(), allowNew: z.boolean().optional() })
    .optional(),
  limits: z
    .strictObject({
      maxFilesChanged: limit("maxFilesChanged").optional(),
      maxLinesChanged: limit("maxLinesChanged").optional(),
      maxAttemptsPerFailure: limit("maxAttemptsPerFailure").optional(),
      maxIterationsPerAttempt: limit("maxIterationsPerAttempt").optional(),
      maxModelTokensPerAttempt: limit("maxModelTokensPerAttempt").optional(),
      maxWallClockMinutes: limit("maxWallClockMinutes").optional(),
    })
    .optional(),
  scope: z
    .strictObject({
      branches: includeExclude.optional(),
      workflows: includeExclude.optional(),
      categories: categories.optional(),
      retryBeforeHeal: z.boolean().optional(),
    })
    .optional(),
  review: z
    .strictObject({
      requestCommitAuthor: z.boolean().optional(),
      draftBelowConfidence: draftBelowConfidence.optional(),
    })
    .optional(),
};

/** What a code-enforced custom rule compiles to: a layer, without custom rules of its own. */
const compiledRuleSchema = z.strictObject(layerFields);

export const customRuleSchema = z
  .strictObject({
    id: z.string().regex(/^CR-[1-9]\d{0,3}$/, "must look like CR-1"),
    /** What the user wrote. */
    text: z.string().trim().min(1).max(1_000),
    /** "code": compiled into structured rules and confirmed; "judge": checked by a model. */
    enforcement: z.enum(["code", "judge"]),
    compiled: compiledRuleSchema.optional(),
  })
  .superRefine((rule, ctx) => {
    if (rule.enforcement === "code" && rule.compiled === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["compiled"],
        message: "a code rule needs its compiled form",
      });
    }
    if (rule.enforcement === "judge" && rule.compiled !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["compiled"],
        message: "a judge rule has no compiled form",
      });
    }
  });
export type CustomRule = z.output<typeof customRuleSchema>;

const customRules = z
  .array(customRuleSchema)
  .max(MAX_CUSTOM_RULES)
  .superRefine((rules, ctx) => {
    const seen = new Set<string>();
    for (const [index, rule] of rules.entries()) {
      if (seen.has(rule.id)) {
        ctx.addIssue({ code: "custom", path: [index, "id"], message: "duplicate rule ID" });
      }
      seen.add(rule.id);
    }
  });

export const policyLayerSchema = z.strictObject({
  ...layerFields,
  customRules: customRules.optional(),
});
export type PolicyLayer = z.output<typeof policyLayerSchema>;

// ---------------------------------------------------------------------------------------------
// A complete policy: every value present, defaults filled in.

const includeExcludeWithDefaults = z
  .strictObject({
    include: globs.default(DEFAULTS.everything),
    exclude: globs.default(() => []),
  })
  .prefault({});

export const policyRulesSchema = z.strictObject({
  paths: z
    .strictObject({ deny: globs.default(DEFAULTS.deny), allow: globs.optional() })
    .prefault({}),
  protectedConfigs: z.boolean().default(true),
  tests: z
    .strictObject({
      mode: testsMode.default("source_only"),
      forbidSkips: z.boolean().default(true),
      forbidAssertionReduction: z.boolean().default(true),
      testGlobs: globs.default(DEFAULTS.testGlobs),
    })
    .prefault({}),
  suppressions: z.strictObject({ forbid: z.boolean().default(true) }).prefault({}),
  dependencies: z
    .strictObject({
      mode: dependencyMode.default("frozen"),
      allowNew: z.boolean().default(false),
    })
    .prefault({}),
  limits: z
    .strictObject({
      maxFilesChanged: limit("maxFilesChanged").default(DEFAULTS.limits.maxFilesChanged),
      maxLinesChanged: limit("maxLinesChanged").default(DEFAULTS.limits.maxLinesChanged),
      maxAttemptsPerFailure: limit("maxAttemptsPerFailure").default(
        DEFAULTS.limits.maxAttemptsPerFailure,
      ),
      maxIterationsPerAttempt: limit("maxIterationsPerAttempt").default(
        DEFAULTS.limits.maxIterationsPerAttempt,
      ),
      maxModelTokensPerAttempt: limit("maxModelTokensPerAttempt").default(
        DEFAULTS.limits.maxModelTokensPerAttempt,
      ),
      maxWallClockMinutes: limit("maxWallClockMinutes").default(
        DEFAULTS.limits.maxWallClockMinutes,
      ),
    })
    .prefault({}),
  scope: z
    .strictObject({
      branches: includeExcludeWithDefaults,
      // Narrows the repository's selected workflows (SPEC §2.1), never widens them.
      workflows: includeExcludeWithDefaults,
      categories: categories.default(DEFAULTS.categories),
      retryBeforeHeal: z.boolean().default(true),
    })
    .prefault({}),
  review: z
    .strictObject({
      requestCommitAuthor: z.boolean().default(true),
      draftBelowConfidence: draftBelowConfidence.default("low"),
    })
    .prefault({}),
  customRules: customRules.default(() => []),
});
export type PolicyRules = z.output<typeof policyRulesSchema>;

/** The policy when no layer sets anything. Frozen: parse again for a mutable copy. */
export const DEFAULT_POLICY: PolicyRules = deepFreeze(policyRulesSchema.parse({}));
