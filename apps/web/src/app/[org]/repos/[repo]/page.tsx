import { hasRole } from "@pipeheal/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { requireOrgMember } from "@/lib/auth/session";
import { policyFileStatus, type PolicyFileStatus } from "@/lib/policy-file";
import { saveWorkflowSelection } from "./actions";

export default async function RepoWorkflowsPage({ params }: PageProps<"/[org]/repos/[repo]">) {
  const { org, repo: repoId } = await params;
  const scope = await requireOrgMember(org);
  const repo = await scope.repositories.get(repoId);
  if (repo === null) notFound();
  const workflows = await scope.workflows.listForRepo(repoId);
  const canManage = hasRole(scope.role, "ADMIN");
  const policyFile = policyFileStatus(repo);

  return (
    <main className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{repo.fullName}</h1>
        <Link
          href={`/${org}/repos/${repo.id}/policy`}
          className="text-sm underline underline-offset-4"
        >
          Policy for this repository
        </Link>
        <p className="text-muted-foreground">
          Choose which workflows PipeHeal watches. CI-looking workflows start pre-selected; you can
          change any of them below (SPEC §11).
        </p>
      </div>
      {workflows.length === 0 ? (
        <p className="text-muted-foreground">No workflows discovered yet.</p>
      ) : canManage ? (
        <form action={saveWorkflowSelection} className="flex flex-col gap-4">
          <input type="hidden" name="org" value={org} />
          <input type="hidden" name="repoId" value={repoId} />
          <ul className="flex flex-col gap-2">
            {workflows.map((workflow) => (
              <li key={workflow.id} className="flex items-center gap-3 rounded-md border px-4 py-3">
                <input
                  type="checkbox"
                  id={`workflow-${workflow.id}`}
                  name="workflow"
                  value={workflow.id}
                  defaultChecked={workflow.selected}
                  className="size-4"
                />
                <label htmlFor={`workflow-${workflow.id}`} className="flex flex-col">
                  <span className="font-medium">{workflow.name}</span>
                  <span className="text-sm text-muted-foreground">{workflow.path}</span>
                </label>
              </li>
            ))}
          </ul>
          <div>
            <Button type="submit">Save selection</Button>
          </div>
        </form>
      ) : (
        <ul className="flex flex-col gap-2">
          {workflows.map((workflow) => (
            <li
              key={workflow.id}
              className="flex items-center justify-between rounded-md border px-4 py-3"
            >
              <div className="flex flex-col">
                <span className="font-medium">{workflow.name}</span>
                <span className="text-sm text-muted-foreground">{workflow.path}</span>
              </div>
              <span className="text-sm text-muted-foreground">
                {workflow.selected ? "Watched" : "Not watched"}
              </span>
            </li>
          ))}
        </ul>
      )}
      <PolicyFileSection status={policyFile} />
    </main>
  );
}

/** `.pipeheal.yml` as the worker last read it from the default branch (P3.7). */
function PolicyFileSection({ status }: { status: PolicyFileStatus }) {
  return (
    <section className="flex flex-col gap-2" aria-labelledby="policy-file">
      <h2 id="policy-file" className="text-lg font-semibold">
        .pipeheal.yml
      </h2>
      {status.state === "unread" ? (
        <p className="text-muted-foreground">
          Not read yet. PipeHeal reads it from the default branch when it next handles a failure.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Read at commit <code>{status.commitSha.slice(0, 7)}</code>
          {status.readAt === null
            ? ""
            : ` on ${status.readAt.toISOString().slice(0, 16).replace("T", " ")} UTC`}
          .
        </p>
      )}
      {status.state === "absent" && (
        <p className="text-muted-foreground">No .pipeheal.yml on the default branch.</p>
      )}
      {status.state === "loaded" && (
        <p>
          In effect. It can only tighten the policy; it sets:{" "}
          {status.fields.length === 0 ? "nothing yet" : status.fields.join(", ")}.
        </p>
      )}
      {status.state === "invalid" && (
        <div className="flex flex-col gap-2 rounded-md border border-destructive px-4 py-3">
          <p className="font-medium">Not in effect: the file has errors.</p>
          <ul className="list-disc pl-5 text-sm">
            {status.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
