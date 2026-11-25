// The effective policy (SPEC §8.1, §8.4, D13), with provenance. Pure.
//
// Layers, in order:
// 1. override (later wins, may loosen): system defaults → org defaults → repo dashboard settings
//    (both set by org admins);
// 2. tighten (most restrictive wins): .pipeheal.yml (anyone who can push may edit it), the
//    compiled form of each code-enforced custom rule, then the org guardrails.
// So nothing ends up looser than the guardrails, and the repo file can only add restrictions.
// Plan maximums are already enforced by the schema (LIMIT_CAPS); invariants aren't layers at all.
//
// A conjunction of glob lists isn't one glob list, so the effective policy keeps every allow list
// (`paths.allowAll`) and every include list (`scope.*.includeAll`): a path or branch must match
// a glob in each.
import {
  DEFAULT_POLICY,
  LIMIT_CAPS,
  policyLayerSchema,
  type CustomRule,
  type HealableCategory,
  type PolicyLayer,
  type PolicyRules,
} from "./rules";

export type LayerName =
  "system" | "org-default" | "repo" | "repo-file" | "org-guardrail" | `custom:${string}`;

export interface PolicyLayers {
  orgGuardrails?: PolicyLayer;
  orgDefaults?: PolicyLayer;
  /** The repository's settings on the dashboard. */
  repo?: PolicyLayer;
  /** `.pipeheal.yml` on the default branch. */
  repoFile?: PolicyLayer;
}

type LimitName = keyof typeof LIMIT_CAPS;

export interface ScopeGlobs {
  /** A name must match a glob in every list. */
  includeAll: string[][];
  exclude: string[];
}

export interface EffectivePolicy {
  paths: {
    deny: string[];
    /** Empty: no whitelist. Otherwise a path must match a glob in every list. */
    allowAll: string[][];
  };
  protectedConfigs: boolean;
  tests: PolicyRules["tests"];
  suppressions: PolicyRules["suppressions"];
  dependencies: PolicyRules["dependencies"];
  limits: Record<LimitName, number>;
  scope: {
    branches: ScopeGlobs;
    workflows: ScopeGlobs;
    categories: HealableCategory[];
    retryBeforeHeal: boolean;
  };
  review: PolicyRules["review"];
  customRules: (CustomRule & { layer: LayerName })[];
}

/** For each field ("limits.maxFilesChanged"), the layers its value comes from. */
export type Provenance = Record<string, LayerName[]>;

// --------------------------------------------------------------------------------------------
// Fields: how each one is read from a layer, overridden, tightened and compared.

type Outcome = "tightened" | "equal" | "ignored";

interface Field {
  key: string;
  /** Replaces the value when the layer sets the field; returns whether it did. */
  override(policy: EffectivePolicy, layer: PolicyLayer): boolean;
  tighten(policy: EffectivePolicy, layer: PolicyLayer): Outcome;
  /** The policy is looser than what the layer asks for. */
  looser(policy: EffectivePolicy, layer: PolicyLayer): boolean;
  /** Lists accumulate their sources; single values come from one layer. */
  accumulates: boolean;
}

const RANK = {
  testsMode: { may_edit_tests: 0, source_only: 1 },
  dependencyMode: { any: 0, minor: 1, patch: 2, frozen: 3 },
  draft: { never: 0, low: 1, medium: 2 },
} as const;

/** A single value where a higher rank is stricter. */
function ranked<T>(
  key: string,
  get: (layer: PolicyLayer) => T | undefined,
  read: (policy: EffectivePolicy) => T,
  write: (policy: EffectivePolicy, value: T) => void,
  rank: (value: T) => number,
): Field {
  return {
    key,
    accumulates: false,
    override(policy, layer) {
      const value = get(layer);
      if (value === undefined) return false;
      write(policy, value);
      return true;
    },
    tighten(policy, layer) {
      const value = get(layer);
      if (value === undefined) return "ignored";
      const current = rank(read(policy));
      if (rank(value) > current) {
        write(policy, value);
        return "tightened";
      }
      return rank(value) === current ? "equal" : "ignored";
    },
    looser(policy, layer) {
      const value = get(layer);
      return value !== undefined && rank(read(policy)) < rank(value);
    },
  };
}

/** A boolean where `strict` is the restrictive value. */
function flag(
  key: string,
  get: (layer: PolicyLayer) => boolean | undefined,
  read: (policy: EffectivePolicy) => boolean,
  write: (policy: EffectivePolicy, value: boolean) => void,
  strict: boolean,
): Field {
  return ranked(key, get, read, write, (value) => (value === strict ? 1 : 0));
}

/** A limit: lower is stricter. */
function limit(name: LimitName): Field {
  return ranked(
    `limits.${name}`,
    (layer) => layer.limits?.[name],
    (policy) => policy.limits[name],
    (policy, value) => {
      policy.limits[name] = value;
    },
    (value) => -value,
  );
}

/** A list where every item is a restriction (deny, test globs, excludes): union. */
function union(
  key: string,
  get: (layer: PolicyLayer) => string[] | undefined,
  read: (policy: EffectivePolicy) => string[],
  write: (policy: EffectivePolicy, value: string[]) => void,
): Field {
  return {
    key,
    accumulates: true,
    override(policy, layer) {
      const value = get(layer);
      if (value === undefined) return false;
      write(policy, [...value]);
      return true;
    },
    tighten(policy, layer) {
      const value = get(layer);
      if (value === undefined) return "ignored";
      const current = read(policy);
      const added = value.filter((item) => !current.includes(item));
      if (added.length === 0) return "equal";
      write(policy, [...current, ...added]);
      return "tightened";
    },
    looser(policy, layer) {
      const value = get(layer);
      return (value ?? []).some((item) => !read(policy).includes(item));
    },
  };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}

/** A list where a name must match (allow, include): every layer's list must match. */
function conjunction(
  key: string,
  get: (layer: PolicyLayer) => string[] | undefined,
  read: (policy: EffectivePolicy) => string[][],
  write: (policy: EffectivePolicy, value: string[][]) => void,
): Field {
  return {
    key,
    accumulates: true,
    override(policy, layer) {
      const value = get(layer);
      if (value === undefined) return false;
      write(policy, [[...value]]);
      return true;
    },
    tighten(policy, layer) {
      const value = get(layer);
      if (value === undefined) return "ignored";
      const current = read(policy);
      if (current.some((list) => sameList(list, value))) return "equal";
      write(policy, [...current, [...value]]);
      return "tightened";
    },
    looser(policy, layer) {
      const value = get(layer);
      // At least as strict when one of its lists allows nothing the layer's doesn't.
      return (
        value !== undefined &&
        !read(policy).some((list) => list.every((item) => value.includes(item)))
      );
    },
  };
}

const FIELDS: readonly Field[] = [
  union(
    "paths.deny",
    (layer) => layer.paths?.deny,
    (policy) => policy.paths.deny,
    (policy, value) => {
      policy.paths.deny = value;
    },
  ),
  conjunction(
    "paths.allow",
    (layer) => layer.paths?.allow,
    (policy) => policy.paths.allowAll,
    (policy, value) => {
      policy.paths.allowAll = value;
    },
  ),
  flag(
    "protectedConfigs",
    (layer) => layer.protectedConfigs,
    (policy) => policy.protectedConfigs,
    (policy, value) => {
      policy.protectedConfigs = value;
    },
    true,
  ),
  ranked(
    "tests.mode",
    (layer) => layer.tests?.mode,
    (policy) => policy.tests.mode,
    (policy, value) => {
      policy.tests.mode = value;
    },
    (value) => RANK.testsMode[value],
  ),
  flag(
    "tests.forbidSkips",
    (layer) => layer.tests?.forbidSkips,
    (policy) => policy.tests.forbidSkips,
    (policy, value) => {
      policy.tests.forbidSkips = value;
    },
    true,
  ),
  flag(
    "tests.forbidAssertionReduction",
    (layer) => layer.tests?.forbidAssertionReduction,
    (policy) => policy.tests.forbidAssertionReduction,
    (policy, value) => {
      policy.tests.forbidAssertionReduction = value;
    },
    true,
  ),
  union(
    "tests.testGlobs",
    (layer) => layer.tests?.testGlobs,
    (policy) => policy.tests.testGlobs,
    (policy, value) => {
      policy.tests.testGlobs = value;
    },
  ),
  flag(
    "suppressions.forbid",
    (layer) => layer.suppressions?.forbid,
    (policy) => policy.suppressions.forbid,
    (policy, value) => {
      policy.suppressions.forbid = value;
    },
    true,
  ),
  ranked(
    "dependencies.mode",
    (layer) => layer.dependencies?.mode,
    (policy) => policy.dependencies.mode,
    (policy, value) => {
      policy.dependencies.mode = value;
    },
    (value) => RANK.dependencyMode[value],
  ),
  flag(
    "dependencies.allowNew",
    (layer) => layer.dependencies?.allowNew,
    (policy) => policy.dependencies.allowNew,
    (policy, value) => {
      policy.dependencies.allowNew = value;
    },
    false,
  ),
  ...(Object.keys(LIMIT_CAPS) as LimitName[]).map(limit),
  ...(["branches", "workflows"] as const).flatMap((which) => [
    conjunction(
      `scope.${which}.include`,
      (layer) => layer.scope?.[which]?.include,
      (policy) => policy.scope[which].includeAll,
      (policy, value) => {
        policy.scope[which].includeAll = value;
      },
    ),
    union(
      `scope.${which}.exclude`,
      (layer) => layer.scope?.[which]?.exclude,
      (policy) => policy.scope[which].exclude,
      (policy, value) => {
        policy.scope[which].exclude = value;
      },
    ),
  ]),
  categoriesField(),
  flag(
    "scope.retryBeforeHeal",
    (layer) => layer.scope?.retryBeforeHeal,
    (policy) => policy.scope.retryBeforeHeal,
    (policy, value) => {
      policy.scope.retryBeforeHeal = value;
    },
    false,
  ),
  flag(
    "review.requestCommitAuthor",
    (layer) => layer.review?.requestCommitAuthor,
    (policy) => policy.review.requestCommitAuthor,
    (policy, value) => {
      policy.review.requestCommitAuthor = value;
    },
    true,
  ),
  ranked(
    "review.draftBelowConfidence",
    (layer) => layer.review?.draftBelowConfidence,
    (policy) => policy.review.draftBelowConfidence,
    (policy, value) => {
      policy.review.draftBelowConfidence = value;
    },
    (value) => RANK.draft[value],
  ),
];

/** Categories in scope: intersection (fewer categories is stricter). */
function categoriesField(): Field {
  const get = (layer: PolicyLayer) => layer.scope?.categories;
  return {
    key: "scope.categories",
    accumulates: true,
    override(policy, layer) {
      const value = get(layer);
      if (value === undefined) return false;
      policy.scope.categories = [...value];
      return true;
    },
    tighten(policy, layer) {
      const value = get(layer);
      if (value === undefined) return "ignored";
      const kept = policy.scope.categories.filter((category) => value.includes(category));
      if (kept.length === policy.scope.categories.length) {
        return sameList(kept, value) ? "equal" : "ignored";
      }
      policy.scope.categories = kept;
      return "tightened";
    },
    looser(policy, layer) {
      const value = get(layer);
      return (
        value !== undefined && policy.scope.categories.some((category) => !value.includes(category))
      );
    },
  };
}

// --------------------------------------------------------------------------------------------

function fromRules(rules: PolicyRules): EffectivePolicy {
  // A copy: DEFAULT_POLICY is frozen, and the merge writes into the result.
  return {
    paths: {
      deny: [...rules.paths.deny],
      allowAll: rules.paths.allow === undefined ? [] : [[...rules.paths.allow]],
    },
    protectedConfigs: rules.protectedConfigs,
    tests: { ...rules.tests, testGlobs: [...rules.tests.testGlobs] },
    suppressions: { ...rules.suppressions },
    dependencies: { ...rules.dependencies },
    limits: { ...rules.limits },
    scope: {
      branches: {
        includeAll: [[...rules.scope.branches.include]],
        exclude: [...rules.scope.branches.exclude],
      },
      workflows: {
        includeAll: [[...rules.scope.workflows.include]],
        exclude: [...rules.scope.workflows.exclude],
      },
      categories: [...rules.scope.categories],
      retryBeforeHeal: rules.scope.retryBeforeHeal,
    },
    review: { ...rules.review },
    customRules: [],
  };
}

/** The effective policy for a repository, and where each value comes from. */
export function effectivePolicy(layers: PolicyLayers): {
  policy: EffectivePolicy;
  provenance: Provenance;
} {
  // Re-validated: callers may pass layers from anywhere (a stored JSON column, a file).
  const parse = (layer: PolicyLayer | undefined) =>
    layer === undefined ? undefined : policyLayerSchema.parse(layer);
  const orgDefaults = parse(layers.orgDefaults);
  const repo = parse(layers.repo);
  const repoFile = parse(layers.repoFile);
  const orgGuardrails = parse(layers.orgGuardrails);

  const policy = fromRules(DEFAULT_POLICY);
  const provenance: Provenance = Object.fromEntries(FIELDS.map((field) => [field.key, ["system"]]));

  const override = (layer: PolicyLayer | undefined, name: LayerName) => {
    if (layer === undefined) return;
    for (const field of FIELDS) {
      if (field.override(policy, layer)) provenance[field.key] = [name];
    }
  };
  const tighten = (layer: PolicyLayer | undefined, name: LayerName) => {
    if (layer === undefined) return;
    for (const field of FIELDS) {
      const outcome = field.tighten(policy, layer);
      const sources = provenance[field.key] ?? [];
      if (outcome === "tightened") {
        provenance[field.key] = field.accumulates ? [...sources, name] : [name];
      } else if (outcome === "equal" && !sources.includes(name)) {
        provenance[field.key] = [...sources, name];
      }
    }
  };

  override(orgDefaults, "org-default");
  override(repo, "repo");
  tighten(repoFile, "repo-file");

  const ruleLayers: [LayerName, PolicyLayer | undefined][] = [
    ["org-default", orgDefaults],
    ["repo", repo],
    ["repo-file", repoFile],
    ["org-guardrail", orgGuardrails],
  ];
  for (const [name, layer] of ruleLayers) {
    for (const rule of layer?.customRules ?? []) {
      policy.customRules.push({ ...rule, layer: name });
      if (rule.compiled !== undefined) tighten(rule.compiled, `custom:${name}:${rule.id}`);
    }
  }

  tighten(orgGuardrails, "org-guardrail");
  return { policy, provenance };
}

/** Fields where `policy` is looser than what `layer` asks for (none: it honors the layer). */
export function looserThan(policy: EffectivePolicy, layer: PolicyLayer): string[] {
  return FIELDS.filter((field) => field.looser(policy, layer)).map((field) => field.key);
}
