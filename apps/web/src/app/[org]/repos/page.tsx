import { hasRole } from "@pipeheal/db";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { requireOrgMember } from "@/lib/auth/session";
import { setRepositoryEnabled } from "./actions";

export default async function ReposPage({ params }: PageProps<"/[org]/repos">) {
  const { org } = await params;
  const scope = await requireOrgMember(org);
  const repositories = await scope.repositories.list();
  const canManage = hasRole(scope.role, "ADMIN");

  return (
    <main className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Repositories</h1>
      {repositories.length === 0 ? (
        <p className="text-muted-foreground">No repositories yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {repositories.map((repo) => (
            <li
              key={repo.id}
              className="flex items-center justify-between gap-4 rounded-md border px-4 py-3"
            >
              <Link href={`/${org}/repos/${repo.id}`} className="underline underline-offset-4">
                {repo.fullName}
              </Link>
              {canManage ? (
                <form action={setRepositoryEnabled}>
                  <input type="hidden" name="org" value={org} />
                  <input type="hidden" name="repoId" value={repo.id} />
                  <input type="hidden" name="enabled" value={repo.enabled ? "false" : "true"} />
                  <Button type="submit" variant={repo.enabled ? "outline" : "default"} size="sm">
                    {repo.enabled ? "Disable" : "Enable"}
                  </Button>
                </form>
              ) : (
                <span className="text-sm text-muted-foreground">
                  {repo.enabled ? "Enabled" : "Disabled"}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
