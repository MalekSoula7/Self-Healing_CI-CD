"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOrgMember } from "@/lib/auth/session";
import { stringField } from "@/lib/form";
import { saveLayer, type SaveState } from "@/lib/policy";
import { enqueueRuleCompile } from "@/lib/queue";

const kindSchema = z.enum(["ORG_DEFAULT", "ORG_GUARDRAIL", "REPO"]);

/**
 * Saves a policy layer from its YAML editor (P3.8). Admins save org defaults and repository
 * settings; only owners save the guardrails. The scope checks the role again, and the YAML is
 * validated with the same reader as `.pipeheal.yml`.
 */
export async function savePolicyAction(
  _previous: SaveState,
  formData: FormData,
): Promise<SaveState> {
  const org = stringField(formData, "org");
  const kind = kindSchema.safeParse(stringField(formData, "kind"));
  if (!kind.success) return { status: "invalid", errors: ["unknown policy layer"] };
  const repoId = kind.data === "REPO" ? stringField(formData, "repoId") : null;
  const scope = await requireOrgMember(org, kind.data === "ORG_GUARDRAIL" ? "OWNER" : "ADMIN");
  const state = await saveLayer(scope, kind.data, repoId, stringField(formData, "yaml"));
  if (state.status === "saved") {
    revalidatePath(repoId === null ? `/${org}/policy` : `/${org}/repos/${repoId}/policy`);
  }
  return state;
}

export type ProposeState =
  { status: "idle" } | { status: "proposed" } | { status: "invalid"; error: string };

const ruleTextSchema = z
  .string()
  .trim()
  .min(1, "Write the rule first.")
  .max(1_000, "At most 1,000 characters.");

/** Proposes a plain-language custom rule; the worker compiles it with the model (P3.9). */
export async function proposeRuleAction(
  _previous: ProposeState,
  formData: FormData,
): Promise<ProposeState> {
  const org = stringField(formData, "org");
  const kind = kindSchema.safeParse(stringField(formData, "kind"));
  if (!kind.success) return { status: "invalid", error: "unknown policy layer" };
  const text = ruleTextSchema.safeParse(stringField(formData, "text"));
  if (!text.success)
    return { status: "invalid", error: text.error.issues[0]?.message ?? "invalid" };
  const repoId = kind.data === "REPO" ? stringField(formData, "repoId") : null;
  const scope = await requireOrgMember(org, kind.data === "ORG_GUARDRAIL" ? "OWNER" : "ADMIN");
  const draft = await scope.customRules.propose(kind.data, repoId, text.data);
  await enqueueRuleCompile({ orgId: scope.org.id, draftId: draft.id });
  revalidatePath(repoId === null ? `/${org}/policy` : `/${org}/repos/${repoId}/policy`);
  return { status: "proposed" };
}

const decisionSchema = z.enum(["code", "judge", "discard"]);

/** Confirms a compiled rule (code), keeps it for the AI judge, or discards it (P3.9). */
export async function decideRuleAction(formData: FormData): Promise<void> {
  const org = stringField(formData, "org");
  const decision = decisionSchema.parse(stringField(formData, "decision"));
  // The draft's own layer decides the role; the scope checks it again.
  const scope = await requireOrgMember(org, "ADMIN");
  const draft = await scope.customRules.getDraft(stringField(formData, "draftId"));
  if (draft === null) return;
  if (decision === "discard") await scope.customRules.discard(draft.id);
  else await scope.customRules.accept(draft.id, decision);
  revalidatePath(draft.repoId === null ? `/${org}/policy` : `/${org}/repos/${draft.repoId}/policy`);
}
