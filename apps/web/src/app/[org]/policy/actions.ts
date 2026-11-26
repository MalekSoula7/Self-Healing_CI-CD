"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOrgMember } from "@/lib/auth/session";
import { stringField } from "@/lib/form";
import { saveLayer, type SaveState } from "@/lib/policy";

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
