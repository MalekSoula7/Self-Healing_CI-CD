import { failureStatusSchema } from "@pipeheal/db";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { requireOrgMember } from "@/lib/auth/session";
import { failureFilters, failuresHref, label, percent, shortSha } from "@/lib/failures";

const PAGE_SIZE = 25;

// SPEC §11: the organization's failures, newest first, filterable by repository and status.
export default async function FailuresPage({ params, searchParams }: PageProps<"/[org]/failures">) {
  const { org } = await params;
  const scope = await requireOrgMember(org);
  const filters = failureFilters(await searchParams);
  const [failures, repositories] = await Promise.all([
    scope.failures.list({ ...filters, take: PAGE_SIZE }),
    scope.repositories.list(),
  ]);
  const last = failures.at(-1);

  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Failures</h1>

      <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          Repository
          <select
            name="repo"
            defaultValue={filters.repoId ?? ""}
            className="rounded-md border bg-background px-2 py-1"
          >
            <option value="">All</option>
            {repositories.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.fullName}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Status
          <select
            name="status"
            defaultValue={filters.status ?? ""}
            className="rounded-md border bg-background px-2 py-1"
          >
            <option value="">All</option>
            {failureStatusSchema.options.map((status) => (
              <option key={status} value={status}>
                {label(status)}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" size="sm" variant="outline">
          Filter
        </Button>
      </form>

      {failures.length === 0 ? (
        <p className="text-muted-foreground">
          {filters.before === undefined ? "No failures yet." : "No older failures."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {failures.map((failure) => (
            <li key={failure.id} className="rounded-md border px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Link
                  href={`/${org}/failures/${failure.id}`}
                  className="font-medium underline underline-offset-4"
                >
                  {failure.repo.fullName} · {failure.headBranch ?? "no branch"} @{" "}
                  <code>{shortSha(failure.headSha)}</code>
                </Link>
                <span className="text-sm text-muted-foreground">
                  {label(failure.status)}
                  {failure.category === null
                    ? ""
                    : ` · ${label(failure.category)} (${percent(failure.confidence)})`}
                </span>
              </div>
              <p className="mt-1 text-sm">
                {failure.summary ?? "Not triaged yet."}{" "}
                <span className="text-muted-foreground">
                  · {failure._count.runs} run{failure._count.runs === 1 ? "" : "s"} ·{" "}
                  {failure.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC
                </span>
              </p>
            </li>
          ))}
        </ul>
      )}

      {failures.length === PAGE_SIZE && last !== undefined ? (
        <div>
          <Button asChild variant="outline" size="sm">
            <Link href={failuresHref(org, { ...filters, before: last.id })}>Older</Link>
          </Button>
        </div>
      ) : null}
    </main>
  );
}
