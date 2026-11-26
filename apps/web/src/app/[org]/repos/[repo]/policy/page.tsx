import { hasRole } from "@pipeheal/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CustomRules } from "@/components/custom-rules";
import { DryRun } from "@/components/dry-run";
import { PolicyEditor } from "@/components/policy-editor";
import { EffectivePolicyTable, PolicyHistory } from "@/components/policy-views";
import { requireOrgMember } from "@/lib/auth/session";
import { effectiveRows } from "@/lib/policy";
import { loadLayer } from "@/lib/policy-page";

/** A repository's policy (SPEC §8.1): its settings, and the effective policy with provenance. */
export default async function RepoPolicyPage({ params }: PageProps<"/[org]/repos/[repo]/policy">) {
  const { org, repo: repoId } = await params;
  const scope = await requireOrgMember(org);
  const repo = await scope.repositories.get(repoId);
  if (repo === null) notFound();
  const [settings, layers, drafts] = await Promise.all([
    loadLayer(scope, "REPO", repo.id),
    scope.policies.layers(repo.id),
    scope.customRules.drafts("REPO", repo.id),
  ]);

  return (
    <main className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{repo.fullName}: policy</h1>
        <p className="text-muted-foreground">
          This repository&apos;s settings override the{" "}
          <Link href={`/${org}/policy`} className="underline underline-offset-4">
            org defaults
          </Link>
          . Its .pipeheal.yml and the org guardrails can only tighten the result (
          <Link href={`/${org}/repos/${repo.id}`} className="underline underline-offset-4">
            .pipeheal.yml status
          </Link>
          ).
        </p>
      </div>

      <section className="flex flex-col gap-3" aria-labelledby="settings">
        <h2 id="settings" className="text-lg font-semibold">
          Repository settings
        </h2>
        <PolicyEditor
          org={org}
          kind="REPO"
          repoId={repo.id}
          initialYaml={settings.yaml}
          canEdit={hasRole(scope.role, "ADMIN")}
          label="Settings (admins can edit)"
        />
        <h3 className="text-base font-medium">Custom rules</h3>
        <CustomRules
          org={org}
          kind="REPO"
          repoId={repo.id}
          rules={settings.rules}
          drafts={drafts}
          canEdit={hasRole(scope.role, "ADMIN")}
        />
        <PolicyHistory entries={settings.history} />
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="effective">
        <h2 id="effective" className="text-lg font-semibold">
          Effective policy
        </h2>
        <EffectivePolicyTable rows={effectiveRows(layers)} />
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="dry-run">
        <h2 id="dry-run" className="text-lg font-semibold">
          Dry run
        </h2>
        <DryRun org={org} repoId={repo.id} />
      </section>
    </main>
  );
}
