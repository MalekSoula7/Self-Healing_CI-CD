// The policy pages (P3.8): the effective policy as rows with their provenance, and saving a layer
// from the YAML editors. Pure except `saveLayer`, which goes through the member's org scope.
import type { OrgScope, StoredLayers } from "@pipeheal/db";
import {
  effectivePolicy,
  parsePolicyYaml,
  type EffectivePolicy,
  type LayerName,
} from "@pipeheal/policy";

export type PolicyKind = "ORG_DEFAULT" | "ORG_GUARDRAIL" | "REPO";

export interface PolicyRow {
  /** The field, as the YAML names it (`limits.maxFilesChanged`). */
  field: string;
  /** Its effective value, as short text. */
  value: string;
  /** The layers it comes from, in order. */
  sources: LayerName[];
}

const LAYER_LABELS: Record<string, string> = {
  system: "PipeHeal default",
  "org-default": "org default",
  repo: "repository setting",
  "repo-file": ".pipeheal.yml",
  "org-guardrail": "org guardrail",
};

/** A layer's name as the pages show it; a code custom rule keeps its ID. */
export function layerLabel(name: LayerName): string {
  return LAYER_LABELS[name] ?? `custom rule ${name.split(":").slice(2).join(":")}`;
}

/** The effective value at a provenance key (lists that combine layers show every list). */
function valueAt(policy: EffectivePolicy, field: string): unknown {
  if (field === "paths.allow") return policy.paths.allowAll;
  const include = /^scope\.(branches|workflows)\.include$/.exec(field);
  if (include !== null) {
    return include[1] === "branches"
      ? policy.scope.branches.includeAll
      : policy.scope.workflows.includeAll;
  }
  let value: unknown = policy;
  for (const key of field.split(".")) {
    value =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)[key]
        : undefined;
  }
  return value;
}

function show(value: unknown): string {
  if (Array.isArray(value) && value.length === 0) return "none";
  const text = JSON.stringify(value);
  return text.length <= 160 ? text : `${text.slice(0, 157)}...`;
}

/** Every field of the effective policy, with its value and where it comes from. */
export function effectiveRows(layers: StoredLayers): PolicyRow[] {
  const { policy, provenance } = effectivePolicy(layers);
  return Object.entries(provenance).map(([field, sources]) => ({
    field,
    value: show(valueAt(policy, field)),
    sources,
  }));
}

export type SaveState =
  | { status: "idle" }
  | { status: "saved"; version: number }
  | { status: "invalid"; errors: string[] };

/** Validates the YAML and saves it as the layer's next version (the scope checks the role). */
export async function saveLayer(
  scope: OrgScope,
  kind: PolicyKind,
  repoId: string | null,
  yaml: string,
): Promise<SaveState> {
  const read = parsePolicyYaml(yaml);
  if (read.layer === null) return { status: "invalid", errors: read.errors };
  const saved = await scope.policies.save(kind, repoId, read.layer);
  return { status: "saved", version: saved.version };
}
