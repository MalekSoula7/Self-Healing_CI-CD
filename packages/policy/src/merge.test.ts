// SPEC §8.1 and §8.4, with D13: org defaults and repo dashboard settings override (an admin may
// loosen them), then .pipeheal.yml, org guardrails and code-enforced custom rules can only tighten.
// Written before the implementation.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  HEALABLE_CATEGORIES,
  LIMIT_CAPS,
  effectivePolicy,
  looserThan,
  type PolicyLayer,
} from "./index";

describe("effectivePolicy", () => {
  it("is the system default when no layer sets anything", () => {
    const { policy, provenance } = effectivePolicy({});

    expect(policy.limits).toEqual(DEFAULT_POLICY.limits);
    expect(policy.paths).toEqual({ deny: DEFAULT_POLICY.paths.deny, allowAll: [] });
    expect(policy.scope.branches).toEqual({ includeAll: [["**"]], exclude: [] });
    expect(provenance["limits.maxFilesChanged"]).toEqual(["system"]);
  });

  it("lets org defaults and then the repo dashboard override, loosening included", () => {
    const { policy, provenance } = effectivePolicy({
      orgDefaults: { limits: { maxFilesChanged: 3 }, tests: { mode: "may_edit_tests" } },
      repo: { limits: { maxFilesChanged: 8 } },
    });

    expect(policy.limits.maxFilesChanged).toBe(8);
    expect(policy.tests.mode).toBe("may_edit_tests");
    expect(provenance["limits.maxFilesChanged"]).toEqual(["repo"]);
    expect(provenance["tests.mode"]).toEqual(["org-default"]);
  });

  it("never lets the repo or its defaults past the org guardrails", () => {
    const { policy, provenance } = effectivePolicy({
      orgGuardrails: { limits: { maxFilesChanged: 6 }, tests: { mode: "source_only" } },
      orgDefaults: { tests: { mode: "may_edit_tests" } },
      repo: { limits: { maxFilesChanged: 20 } },
    });

    expect(policy.limits.maxFilesChanged).toBe(6);
    expect(policy.tests.mode).toBe("source_only");
    expect(provenance["limits.maxFilesChanged"]).toEqual(["org-guardrail"]);
  });

  it("lets .pipeheal.yml tighten but never loosen", () => {
    const loosening = effectivePolicy({
      repoFile: {
        limits: { maxFilesChanged: 40 },
        tests: { mode: "may_edit_tests" },
        suppressions: { forbid: false },
        dependencies: { mode: "any", allowNew: true },
      },
    });
    const tightening = effectivePolicy({
      repoFile: { limits: { maxFilesChanged: 2 }, paths: { deny: ["src/legacy/**"] } },
    });

    expect(loosening.policy.limits.maxFilesChanged).toBe(5);
    expect(loosening.policy.tests.mode).toBe("source_only");
    expect(loosening.policy.suppressions.forbid).toBe(true);
    expect(loosening.policy.dependencies).toEqual({ mode: "frozen", allowNew: false });
    expect(tightening.policy.limits.maxFilesChanged).toBe(2);
    expect(tightening.policy.paths.deny).toContain("src/legacy/**");
    expect(tightening.provenance["paths.deny"]).toEqual(["system", "repo-file"]);
  });

  it("merges each field as SPEC §8.4 says", () => {
    const { policy } = effectivePolicy({
      repo: {
        paths: { deny: ["a/**"], allow: ["src/**", "lib/**"] },
        dependencies: { mode: "any" },
        scope: { categories: ["test", "lint", "typecheck"], branches: { include: ["main"] } },
      },
      repoFile: {
        paths: { deny: ["b/**"], allow: ["src/**"] },
        dependencies: { mode: "patch" },
        scope: { categories: ["test", "compile"], branches: { exclude: ["release/**"] } },
      },
      orgGuardrails: {
        dependencies: { mode: "minor" },
        scope: { retryBeforeHeal: false, branches: { include: ["main", "dev"] } },
        review: { draftBelowConfidence: "medium" },
      },
    });

    // Deny: union. Allow: every layer's list must allow the path.
    expect(policy.paths.deny).toEqual(expect.arrayContaining(["a/**", "b/**"]));
    expect(policy.paths.allowAll).toEqual([["src/**", "lib/**"], ["src/**"]]);
    // Dependencies: most restrictive (frozen < patch < minor < any).
    expect(policy.dependencies.mode).toBe("patch");
    // Categories: intersection.
    expect(policy.scope.categories).toEqual(["test"]);
    // Branches: every include list must match, excludes add up.
    expect(policy.scope.branches).toEqual({
      includeAll: [["main"], ["main", "dev"]],
      exclude: ["release/**"],
    });
    // Off wins for re-runs; more drafting wins.
    expect(policy.scope.retryBeforeHeal).toBe(false);
    expect(policy.review.draftBelowConfidence).toBe("medium");
  });

  it("applies every layer's custom rules, and code rules tighten like a layer", () => {
    const { policy, provenance } = effectivePolicy({
      orgDefaults: {
        customRules: [{ id: "CR-1", text: "No payments changes.", enforcement: "judge" }],
      },
      repo: {
        customRules: [
          {
            id: "CR-1",
            text: "Keep the legacy importer untouched.",
            enforcement: "code",
            compiled: { paths: { deny: ["src/importer/**"] }, limits: { maxLinesChanged: 50 } },
          },
        ],
      },
    });

    expect(policy.customRules.map((rule) => `${rule.layer}:${rule.id}`)).toEqual([
      "org-default:CR-1",
      "repo:CR-1",
    ]);
    expect(policy.paths.deny).toContain("src/importer/**");
    expect(policy.limits.maxLinesChanged).toBe(50);
    expect(provenance["limits.maxLinesChanged"]).toEqual(["custom:repo:CR-1"]);
  });

  it("is deterministic and doesn't change its inputs", () => {
    const makeLayers = () => ({
      repo: { paths: { deny: ["x/**"] } },
      repoFile: { limits: { maxFilesChanged: 1 } },
    });
    const layers = makeLayers();
    const copy = makeLayers();

    expect(effectivePolicy(layers)).toEqual(effectivePolicy(layers));
    expect(layers).toEqual(copy);
  });
});

describe("looserThan", () => {
  it("names each field where a policy is looser than a layer", () => {
    const { policy } = effectivePolicy({});

    expect(looserThan(policy, { limits: { maxFilesChanged: 2 } })).toEqual([
      "limits.maxFilesChanged",
    ]);
    expect(looserThan(policy, { paths: { deny: ["x/**"], allow: ["src/**"] } })).toEqual([
      "paths.deny",
      "paths.allow",
    ]);
    expect(looserThan(policy, { limits: { maxFilesChanged: 9 } })).toEqual([]);
  });
});

// --------------------------------------------------------------------------------------------
// Properties (SPEC §8.4): whatever the layers, the result is never looser than a tightening layer.

const glob = fc.constantFrom("src/**", "lib/**", "a/**", "b/**", "main", "dev", "release/**", "**");
const globList = fc.uniqueArray(glob, { maxLength: 4 });
const limitArbitrary = (name: keyof typeof LIMIT_CAPS) =>
  fc.integer({ min: 1, max: LIMIT_CAPS[name] });

const layerArbitrary: fc.Arbitrary<PolicyLayer> = fc.record(
  {
    paths: fc.record({ deny: globList, allow: globList }, { requiredKeys: [] }),
    protectedConfigs: fc.boolean(),
    tests: fc.record(
      {
        mode: fc.constantFrom("source_only" as const, "may_edit_tests" as const),
        forbidSkips: fc.boolean(),
        forbidAssertionReduction: fc.boolean(),
        testGlobs: globList,
      },
      { requiredKeys: [] },
    ),
    suppressions: fc.record({ forbid: fc.boolean() }, { requiredKeys: [] }),
    dependencies: fc.record(
      {
        mode: fc.constantFrom(
          "frozen" as const,
          "patch" as const,
          "minor" as const,
          "any" as const,
        ),
        allowNew: fc.boolean(),
      },
      { requiredKeys: [] },
    ),
    limits: fc.record(
      {
        maxFilesChanged: limitArbitrary("maxFilesChanged"),
        maxLinesChanged: limitArbitrary("maxLinesChanged"),
        maxAttemptsPerFailure: limitArbitrary("maxAttemptsPerFailure"),
        maxIterationsPerAttempt: limitArbitrary("maxIterationsPerAttempt"),
        maxModelTokensPerAttempt: limitArbitrary("maxModelTokensPerAttempt"),
        maxWallClockMinutes: limitArbitrary("maxWallClockMinutes"),
      },
      { requiredKeys: [] },
    ),
    scope: fc.record(
      {
        branches: fc.record({ include: globList, exclude: globList }, { requiredKeys: [] }),
        workflows: fc.record({ include: globList, exclude: globList }, { requiredKeys: [] }),
        categories: fc.uniqueArray(fc.constantFrom(...HEALABLE_CATEGORIES)),
        retryBeforeHeal: fc.boolean(),
      },
      { requiredKeys: [] },
    ),
    review: fc.record(
      {
        requestCommitAuthor: fc.boolean(),
        draftBelowConfidence: fc.constantFrom("low" as const, "medium" as const, "never" as const),
      },
      { requiredKeys: [] },
    ),
  },
  { requiredKeys: [] },
);

describe("merge properties", () => {
  it("is never looser than the org guardrails or .pipeheal.yml, whatever the other layers say", () => {
    fc.assert(
      fc.property(
        layerArbitrary,
        layerArbitrary,
        layerArbitrary,
        layerArbitrary,
        (orgDefaults, repo, repoFile, orgGuardrails) => {
          const { policy } = effectivePolicy({ orgDefaults, repo, repoFile, orgGuardrails });
          expect(looserThan(policy, orgGuardrails)).toEqual([]);
          expect(looserThan(policy, repoFile)).toEqual([]);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("never gets looser when a tightening layer is added", () => {
    fc.assert(
      fc.property(layerArbitrary, layerArbitrary, layerArbitrary, (repo, guardrails, extra) => {
        const before = effectivePolicy({ repo, orgGuardrails: guardrails }).policy;
        const after = effectivePolicy({ repo, orgGuardrails: guardrails, repoFile: extra }).policy;
        // Everything the first result enforced, the second still enforces.
        expect(looserThan(after, { ...asLayer(before) })).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it("keeps every limit within the plan maximums", () => {
    fc.assert(
      fc.property(layerArbitrary, layerArbitrary, (orgDefaults, repo) => {
        const { policy } = effectivePolicy({ orgDefaults, repo });
        for (const [name, cap] of Object.entries(LIMIT_CAPS)) {
          expect(policy.limits[name as keyof typeof LIMIT_CAPS]).toBeLessThanOrEqual(cap);
        }
      }),
      { numRuns: 200 },
    );
  });
});

/** An effective policy's restrictions as a layer, for comparing two results. */
function asLayer(policy: ReturnType<typeof effectivePolicy>["policy"]): PolicyLayer {
  return {
    paths: { deny: policy.paths.deny },
    protectedConfigs: policy.protectedConfigs,
    tests: policy.tests,
    suppressions: policy.suppressions,
    dependencies: policy.dependencies,
    limits: policy.limits,
    scope: {
      categories: policy.scope.categories,
      retryBeforeHeal: policy.scope.retryBeforeHeal,
      branches: { exclude: policy.scope.branches.exclude },
      workflows: { exclude: policy.scope.workflows.exclude },
    },
    review: policy.review,
  };
}
