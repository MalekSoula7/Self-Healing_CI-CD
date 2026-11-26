// Loading a policy layer for its page (P3.8): the current version as editor YAML, and its history
// with author names. Stored rules are re-validated before they reach the editor.
import type { OrgScope } from "@pipeheal/db";
import { formatPolicyYaml, policyLayerSchema, type CustomRule } from "@pipeheal/policy";
import type { HistoryEntry } from "@/components/policy-views";
import type { PolicyKind } from "@/lib/policy";

export interface LayerView {
  yaml: string;
  history: HistoryEntry[];
  /** The layer's custom rules (P3.9), from its current version. */
  rules: CustomRule[];
}

export async function loadLayer(
  scope: OrgScope,
  kind: PolicyKind,
  repoId: string | null,
): Promise<LayerView> {
  const [current, history, members] = await Promise.all([
    scope.policies.current(kind, repoId),
    scope.policies.history(kind, repoId, 10),
    scope.members.list(),
  ]);
  const names = new Map(
    members.map((member) => [member.user.id, member.user.login ?? member.user.name]),
  );
  const layer = current === null ? {} : policyLayerSchema.parse(current.rules);
  return {
    yaml: current === null ? "" : formatPolicyYaml(layer),
    rules: layer.customRules ?? [],
    history: history.map((row) => ({
      id: row.id,
      version: row.version,
      createdAt: row.createdAt,
      author:
        row.createdById === null ? "PipeHeal" : (names.get(row.createdById) ?? "a former member"),
    })),
  };
}
