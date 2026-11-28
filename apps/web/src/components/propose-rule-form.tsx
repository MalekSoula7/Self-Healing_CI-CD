"use client";

import { useActionState } from "react";
import { proposeRuleAction, type ProposeState } from "@/app/[org]/policy/actions";
import { Button } from "@/components/ui/button";
import type { PolicyKind } from "@/lib/policy";

const IDLE: ProposeState = { status: "idle" };

/** Proposes a plain-language rule; the model then suggests how to enforce it (P3.9). */
export function ProposeRuleForm({
  org,
  kind,
  repoId,
}: {
  org: string;
  kind: PolicyKind;
  repoId: string | null;
}) {
  const [state, formAction, pending] = useActionState(proposeRuleAction, IDLE);
  const id = `rule-${kind.toLowerCase()}`;
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="kind" value={kind} />
      {repoId !== null && <input type="hidden" name="repoId" value={repoId} />}
      <label htmlFor={id} className="text-sm font-medium">
        Add a rule in plain language
      </label>
      <textarea
        id={id}
        name="text"
        rows={2}
        maxLength={1000}
        placeholder="e.g. Don't touch the payments module."
        className="rounded-md border bg-background px-3 py-2 text-sm"
      />
      <p aria-live="polite" className="text-sm">
        {state.status === "proposed" && "Proposed. PipeHeal is working out how to enforce it."}
        {state.status === "invalid" && <span className="text-destructive">{state.error}</span>}
      </p>
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Proposing..." : "Propose rule"}
        </Button>
      </div>
    </form>
  );
}
