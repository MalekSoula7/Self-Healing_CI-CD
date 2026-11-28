"use client";

import { useActionState } from "react";
import { dryRunAction } from "@/app/[org]/policy/actions";
import { Button } from "@/components/ui/button";
import type { DryRunState } from "@/lib/policy";

const IDLE: DryRunState = { status: "idle" };

/** A dry run of the repository's effective policy against a pasted diff (SPEC §8.9, P3.10). */
export function DryRun({ org, repoId }: { org: string; repoId: string }) {
  const [state, formAction, pending] = useActionState(dryRunAction, IDLE);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="repoId" value={repoId} />
      <label htmlFor="dry-run-diff" className="text-sm font-medium">
        Paste a diff (the output of git diff)
      </label>
      <textarea
        id="dry-run-diff"
        name="diff"
        rows={8}
        spellCheck={false}
        className="rounded-md border bg-background px-3 py-2 font-mono text-xs"
      />
      <p className="text-xs text-muted-foreground">
        A diff holds only the changed lines, so checks that read whole files (assertion counts,
        manifests) see only those. Real fixes are always checked on full files.
      </p>
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Checking..." : "Check against the policy"}
        </Button>
      </div>
      <div aria-live="polite" className="text-sm">
        {state.status === "invalid" && <p className="text-destructive">{state.error}</p>}
        {state.status === "done" && (
          <div className="flex flex-col gap-2">
            <p>
              {state.files} {state.files === 1 ? "file" : "files"}:{" "}
              {state.violations.length === 0
                ? "the policy allows this change."
                : `${String(state.violations.length)} ${state.violations.length === 1 ? "rule" : "rules"} would refuse it.`}
            </p>
            {state.violations.length > 0 && (
              <ul className="list-disc pl-5">
                {state.violations.map((violation, index) => (
                  <li key={`${violation.ruleId}-${String(index)}`}>
                    <span className="font-mono">{violation.ruleId}</span>: {violation.message}
                  </li>
                ))}
              </ul>
            )}
            {state.drafts.map((reason) => (
              <p key={reason} className="text-muted-foreground">
                Would open as a draft: {reason}
              </p>
            ))}
          </div>
        )}
      </div>
    </form>
  );
}
