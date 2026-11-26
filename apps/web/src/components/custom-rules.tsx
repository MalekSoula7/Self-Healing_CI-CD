// Custom rules on a policy page (SPEC §8.7, P3.9): the layer's rules with how each is enforced, the
// proposals waiting for a decision, and a form to propose one.
import type { CustomRule } from "@pipeheal/policy";
import { formatPolicyYaml, policyLayerSchema } from "@pipeheal/policy";
import { decideRuleAction } from "@/app/[org]/policy/actions";
import { ProposeRuleForm } from "@/components/propose-rule-form";
import { Button } from "@/components/ui/button";
import type { PolicyKind } from "@/lib/policy";

export interface RuleDraftView {
  id: string;
  text: string;
  status: "PENDING" | "COMPILED" | "FAILED" | "ACCEPTED" | "DISCARDED";
  compiled: unknown;
  explanation: string | null;
  error: string | null;
}

interface CustomRulesProps {
  org: string;
  kind: PolicyKind;
  repoId: string | null;
  rules: CustomRule[];
  drafts: RuleDraftView[];
  canEdit: boolean;
}

/** The compiled layer as YAML, re-validated (it was stored by the worker). */
function compiledYaml(compiled: unknown): string | null {
  const parsed = policyLayerSchema.safeParse(compiled);
  // An empty layer enforces nothing: never offer it as "Enforced by code".
  return parsed.success && Object.keys(parsed.data).length > 0
    ? formatPolicyYaml(parsed.data)
    : null;
}

function Decide({
  org,
  draftId,
  decision,
  label,
}: {
  org: string;
  draftId: string;
  decision: string;
  label: string;
}) {
  return (
    <form action={decideRuleAction}>
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="draftId" value={draftId} />
      <input type="hidden" name="decision" value={decision} />
      <Button type="submit" variant={decision === "discard" ? "outline" : "default"} size="sm">
        {label}
      </Button>
    </form>
  );
}

export function CustomRules({ org, kind, repoId, rules, drafts, canEdit }: CustomRulesProps) {
  return (
    <div className="flex flex-col gap-3">
      {rules.length === 0 ? (
        <p className="text-sm text-muted-foreground">No custom rules.</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {rules.map((rule) => (
            <li key={rule.id} className="rounded-md border px-3 py-2">
              <span className="font-mono">{rule.id}</span>{" "}
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                {rule.enforcement === "code"
                  ? "Enforced by code"
                  : "Checked by AI judge (best effort)"}
              </span>
              <p className="mt-1">{rule.text}</p>
            </li>
          ))}
        </ul>
      )}

      {drafts.map((draft) => {
        const yaml = compiledYaml(draft.compiled);
        return (
          <div
            key={draft.id}
            className="flex flex-col gap-2 rounded-md border border-dashed px-3 py-2 text-sm"
          >
            <p>
              <span className="font-medium">Proposed:</span> {draft.text}
            </p>
            {draft.status === "PENDING" && (
              <p className="text-muted-foreground">Compiling... reload in a moment.</p>
            )}
            {draft.status === "FAILED" && (
              <p className="text-muted-foreground">
                Couldn&apos;t compile it ({draft.error}). It can still be checked by the AI judge.
              </p>
            )}
            {draft.status === "COMPILED" && (
              <>
                <p className="text-muted-foreground">{draft.explanation}</p>
                {yaml !== null && (
                  <pre className="overflow-x-auto rounded bg-muted px-3 py-2 font-mono text-xs">
                    {yaml}
                  </pre>
                )}
              </>
            )}
            {canEdit && draft.status !== "PENDING" && (
              <div className="flex flex-wrap gap-2">
                {yaml !== null && (
                  <Decide org={org} draftId={draft.id} decision="code" label="Enforce by code" />
                )}
                <Decide org={org} draftId={draft.id} decision="judge" label="Check by AI judge" />
                <Decide org={org} draftId={draft.id} decision="discard" label="Discard" />
              </div>
            )}
          </div>
        );
      })}

      {canEdit && <ProposeRuleForm org={org} kind={kind} repoId={repoId} />}
    </div>
  );
}
