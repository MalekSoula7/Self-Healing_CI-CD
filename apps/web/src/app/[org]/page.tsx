import { requireOrgMember } from "@/lib/auth/session";

export default async function OrgDashboardPage({ params }: PageProps<"/[org]">) {
  const { org } = await params;
  // Pages check too: a layout doesn't re-run on every client-side navigation.
  const scope = await requireOrgMember(org);
  const repositories = await scope.repositories.list();

  return (
    <main className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Repositories</h1>
      {repositories.length === 0 ? (
        <p className="text-muted-foreground">No repositories yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {repositories.map((repo) => (
            <li key={repo.id} className="flex justify-between rounded-md border px-4 py-3">
              <span>{repo.fullName}</span>
              <span className="text-sm text-muted-foreground">
                {repo.enabled ? "Enabled" : "Disabled"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
