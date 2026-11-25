// @pipeheal/policy: the rules engine (SPEC §8). Pure functions, no I/O, no network.
export { INVARIANTS, INVARIANT_PATHS, type Invariant, type InvariantId } from "./invariants";
export {
  DEFAULT_POLICY,
  HEALABLE_CATEGORIES,
  LIMIT_CAPS,
  customRuleSchema,
  globSchema,
  policyLayerSchema,
  policyRulesSchema,
  type CustomRule,
  type HealableCategory,
  type PolicyLayer,
  type PolicyRules,
} from "./rules";
export {
  MAX_EDIT_DISTANCE,
  buildChange,
  diffLines,
  splitLines,
  type Change,
  type ChangeInput,
  type ChangeStatus,
  type DiffOp,
  type FileKind,
  type FileMode,
  type FileState,
  type Hunk,
  type HunkLine,
  type LineDiff,
} from "./diff";
export {
  effectivePolicy,
  looserThan,
  type EffectivePolicy,
  type LayerName,
  type PolicyLayers,
  type Provenance,
  type ScopeGlobs,
} from "./merge";
export {
  MAX_GLOB_ALTERNATIVES,
  compileGlob,
  globList,
  globMatches,
  type CompiledGlob,
  type GlobList,
} from "./glob";
export { checkChanges, type Violation } from "./checks";
export {
  MAX_REPORT_CHARS,
  MAX_TESTS,
  mergeInventories,
  parseJunit,
  testCount,
  type JunitRead,
  type TestInventory,
  type TestOutcome,
} from "./behavior/junit";
export { compareInventories } from "./behavior/inventory";
