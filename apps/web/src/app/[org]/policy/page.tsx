import { hasRole } from "@pipeheal/db";
import { CustomRules } from "@/components/custom-rules";
import { PolicyEditor } from "@/components/policy-editor";
import { EffectivePolicyTable, PolicyHistory } from "@/components/policy-views";
import { requireOrgMember } from "@/lib/auth/session";
import { effectiveRows } from "@/lib/policy";
import { loadLayer } from "@/lib/policy-page";

/** The organization's policy layers (SPEC §8.1, D13): defaults and guardrails, with history. */
export default async function OrgPolicyPage({ params }: PageProps<"/[org]/policy">) {
  const { org } = await params;
  const scope = await requireOrgMember(org);
  const [defaults, guardrails, layers, defaultDrafts, guardrailDrafts] = await Promise.all([
    loadLayer(scope, "ORG_DEFAULT", null),
    loadLayer(scope, "ORG_GUARDRAIL", null),
    scope.policies.layers(null),
    scope.customRules.drafts("ORG_DEFAULT"),
    scope.customRules.drafts("ORG_GUARDRAIL"),
  ]);

  return (
    <main className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Policy</h1>
        <p className="text-muted-foreground">
          What PipeHeal may change when it fixes a failure. Org defaults apply to every repository,
          and a repository&apos;s own settings may override them. Guardrails are the ceiling:
          nothing, not a repository setting or its .pipeheal.yml, can be looser.
        </p>
      </div>

      <section className="flex flex-col gap-3" aria-labelledby="defaults">
        <h2 id="defaults" className="text-lg font-semibold">
          Org defaults
        </h2>
        <PolicyEditor
          org={org}
          kind="ORG_DEFAULT"
          repoId={null}
          initialYaml={defaults.yaml}
          canEdit={hasRole(scope.role, "ADMIN")}
          label="Defaults (admins can edit)"
        />
        <h3 className="text-base font-medium">Custom rules</h3>
        <CustomRules
          org={org}
          kind="ORG_DEFAULT"
          repoId={null}
          rules={defaults.rules}
          drafts={defaultDrafts}
          canEdit={hasRole(scope.role, "ADMIN")}
        />
        <PolicyHistory entries={defaults.history} />
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="guardrails">
        <h2 id="guardrails" className="text-lg font-semibold">
          Guardrails
        </h2>
        <PolicyEditor
          org={org}
          kind="ORG_GUARDRAIL"
          repoId={null}
          initialYaml={guardrails.yaml}
          canEdit={hasRole(scope.role, "OWNER")}
          label="Guardrails (owners can edit)"
        />
        <h3 className="text-base font-medium">Custom rules</h3>
        <CustomRules
          org={org}
          kind="ORG_GUARDRAIL"
          repoId={null}
          rules={guardrails.rules}
          drafts={guardrailDrafts}
          canEdit={hasRole(scope.role, "OWNER")}
        />
        <PolicyHistory entries={guardrails.history} />
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="effective">
        <h2 id="effective" className="text-lg font-semibold">
          Effective org-wide policy
        </h2>
        <p className="text-sm text-muted-foreground">
          Before any repository&apos;s own settings. Each repository&apos;s page shows its own.
        </p>
        <EffectivePolicyTable rows={effectiveRows(layers)} />
      </section>
    </main>
  );
}
