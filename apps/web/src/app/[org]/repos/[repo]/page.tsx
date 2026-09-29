import { hasRole } from "@pipeheal/db";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { requireOrgMember } from "@/lib/auth/session";
import { saveWorkflowSelection } from "./actions";

export default async function RepoWorkflowsPage({ params }: PageProps<"/[org]/repos/[repo]">) {
  const { org, repo: repoId } = await params;
  const scope = await requireOrgMember(org);
  const repo = await scope.repositories.get(repoId);
  if (repo === null) notFound();
  const workflows = await scope.workflows.listForRepo(repoId);
  const canManage = hasRole(scope.role, "ADMIN");

  return (
    <main className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{repo.fullName}</h1>
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
    </main>
  );
}
