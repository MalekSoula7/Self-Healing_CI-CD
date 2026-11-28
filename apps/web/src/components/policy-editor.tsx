"use client";

import { useActionState } from "react";
import { savePolicyAction } from "@/app/[org]/policy/actions";
import { Button } from "@/components/ui/button";
import type { PolicyKind, SaveState } from "@/lib/policy";

interface PolicyEditorProps {
  org: string;
  kind: PolicyKind;
  repoId: string | null;
  /** The current version as YAML ("" when none was saved). */
  initialYaml: string;
  canEdit: boolean;
  label: string;
}

const IDLE: SaveState = { status: "idle" };

/** A policy layer as YAML, in the same format as `.pipeheal.yml` (P3.8). */
export function PolicyEditor({
  org,
  kind,
  repoId,
  initialYaml,
  canEdit,
  label,
}: PolicyEditorProps) {
  const [state, formAction, pending] = useActionState(savePolicyAction, IDLE);
  const id = `policy-${kind.toLowerCase()}`;
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="kind" value={kind} />
      {repoId !== null && <input type="hidden" name="repoId" value={repoId} />}
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <textarea
        id={id}
        name="yaml"
        defaultValue={initialYaml}
        readOnly={!canEdit}
        rows={10}
        spellCheck={false}
        placeholder={canEdit ? "# YAML, as in .pipeheal.yml. Empty: this layer sets nothing." : ""}
        className="rounded-md border bg-background px-3 py-2 font-mono text-sm"
      />
      <div aria-live="polite" className="text-sm">
        {state.status === "saved" && <p>Saved as version {state.version}.</p>}
        {state.status === "invalid" && (
          <ul className="list-disc pl-5 text-destructive">
            {state.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        )}
      </div>
      {canEdit && (
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving..." : "Save as a new version"}
          </Button>
        </div>
      )}
    </form>
  );
}
