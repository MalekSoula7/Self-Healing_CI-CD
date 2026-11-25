import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgMember } from "@/lib/auth/session";
import { label, percent, shortSha, storedRecentChanges, storedSignals } from "@/lib/failures";

// SPEC §11: one failure: its triage (category, summary), each failed job's error window and
// signals, and what changed since the last green commit. Error windows and diffs are customer
// content, already redacted: shown as text, never as markup.
export default async function FailurePage({ params }: PageProps<"/[org]/failures/[id]">) {
  const { org, id } = await params;
  const scope = await requireOrgMember(org);
  const failure = await scope.failures.get(id);
  if (failure === null) notFound();
  const repo = await scope.repositories.get(failure.repoId);
  const recent = storedRecentChanges(failure.recentChanges);

  return (
    <main className="flex flex-col gap-8">
      <section className="flex flex-col gap-2">
        <Link href={`/${org}/failures`} className="text-sm text-muted-foreground underline">
          ← Failures
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {repo?.fullName ?? "Repository"} · {failure.headBranch ?? "no branch"} @{" "}
          <code>{shortSha(failure.headSha)}</code>
        </h1>
        <p>
          <strong>{label(failure.status)}</strong>
          {failure.category === null
            ? ""
            : ` · ${label(failure.category)} (${percent(failure.confidence)} confidence)`}
        </p>
        <p>{failure.summary ?? "Not triaged yet."}</p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">Failed runs</h2>
        {failure.runs.map((run) => (
          <article key={run.id} className="flex flex-col gap-3 rounded-md border p-4">
            <header className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-medium">
                {run.workflowName} · attempt {run.runAttempt} · {label(run.conclusion)}
                {run.rerunByUs ? " · re-run by PipeHeal" : ""}
                {run.lateArrival ? " · late arrival" : ""}
              </h3>
              {run.htmlUrl === null ? null : (
                <a
                  href={run.htmlUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm underline"
                >
                  View on GitHub
                </a>
              )}
            </header>
            {run.jobs.map((job) => {
              const signals = storedSignals(job.signals);
              return (
                <div key={job.id} className="flex flex-col gap-2">
                  <p>
                    <strong>{job.name}</strong>
                    {job.failedStep === null ? "" : ` · step “${job.failedStep}”`}
                    {job.category === null
                      ? ""
                      : ` · ${label(job.category)} (${percent(job.confidence)})`}
                  </p>
                  {job.summary === null ? null : <p className="text-sm">{job.summary}</p>}
                  {signals === null ? null : <Signals signals={signals} />}
                  {job.errorWindow === null ? (
                    <p className="text-sm text-muted-foreground">Log not triaged yet.</p>
                  ) : job.errorWindow === "" ? (
                    <p className="text-sm text-muted-foreground">GitHub no longer has this log.</p>
                  ) : (
                    <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs">
                      {job.errorWindow}
                    </pre>
                  )}
                </div>
              );
            })}
          </article>
        ))}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Recent changes</h2>
        {recent === null ? (
          <p className="text-sm text-muted-foreground">Not resolved yet.</p>
        ) : recent.base === null ? (
          <p className="text-sm text-muted-foreground">{recent.reason}</p>
        ) : (
          <>
            <p className="text-sm">
              Since <code>{shortSha(recent.base.sha)}</code> ({sourceLabel(recent.base.source)} on{" "}
              {recent.base.branch}) · {recent.changes.totalCommits} commit
              {recent.changes.totalCommits === 1 ? "" : "s"}, {recent.changes.totalFiles} file
              {recent.changes.totalFiles === 1 ? "" : "s"}
              {recent.changes.githubTruncated ? " (GitHub listed only part of them)" : ""}
            </p>
            <ul className="text-sm">
              {recent.changes.commits.map((commit) => (
                <li key={commit.sha}>
                  <code>{shortSha(commit.sha)}</code> {commit.subject}
                  {commit.authorLogin === null ? "" : ` (${commit.authorLogin})`}
                </li>
              ))}
              {recent.changes.omittedCommits > 0 ? (
                <li className="text-muted-foreground">
                  … {recent.changes.omittedCommits} more not shown
                </li>
              ) : null}
            </ul>
            {recent.changes.files.map((file) => (
              <div key={file.path} className="flex flex-col gap-1">
                <p className="text-sm">
                  {file.status}{" "}
                  <code>
                    {file.previousPath === null ? "" : `${file.previousPath} → `}
                    {file.path}
                  </code>{" "}
                  (+{file.additions} −{file.deletions})
                  {file.priority ? " · named in the failure" : ""}
                  {file.patchState === "omitted" ? " · diff not shown (too large)" : ""}
                  {file.patchState === "none" ? " · no text diff" : ""}
                  {file.patchState === "partial" ? " · diff shortened" : ""}
                </p>
                {file.patch === null ? null : (
                  <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs">
                    {file.patch}
                  </pre>
                )}
              </div>
            ))}
            {recent.changes.omittedFiles > 0 ? (
              <p className="text-sm text-muted-foreground">
                … {recent.changes.omittedFiles} more changed files not shown
              </p>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}

function sourceLabel(source: "same-branch" | "default-branch" | "merge-base"): string {
  if (source === "same-branch") return "last green run";
  if (source === "default-branch") return "last green run of the default branch";
  return "where the branch left the default branch";
}

function Signals({ signals }: { signals: NonNullable<ReturnType<typeof storedSignals>> }) {
  const rows: [string, string[]][] = [
    ["Failing tests", signals.failingTests],
    ["Locations", signals.locations.map((l) => `${l.path}:${String(l.line)}`)],
    ["Error codes", signals.errorCodes],
    ["Tools", signals.tools],
  ];
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      {rows
        .filter(([, values]) => values.length > 0)
        .map(([name, values]) => (
          <div key={name} className="contents">
            <dt className="text-muted-foreground">{name}</dt>
            <dd>
              <code>{values.join(", ")}</code>
            </dd>
          </div>
        ))}
      {signals.exitCode === null ? null : (
        <div className="contents">
          <dt className="text-muted-foreground">Exit code</dt>
          <dd>
            <code>{signals.exitCode}</code>
          </dd>
        </div>
      )}
    </dl>
  );
}
