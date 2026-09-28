"use server";

import { redirect } from "next/navigation";
import { requireOrgMember } from "@/lib/auth/session";
import { stringField } from "@/lib/form";

export async function saveWorkflowSelection(formData: FormData): Promise<void> {
  const org = stringField(formData, "org");
  const repoId = stringField(formData, "repoId");
  const scope = await requireOrgMember(org, "ADMIN");
  const workflows = await scope.workflows.listForRepo(repoId);
  const checked = new Set(formData.getAll("workflow").filter((v) => typeof v === "string"));
  for (const workflow of workflows) {
    await scope.workflows.setSelected(workflow.id, checked.has(workflow.id));
  }
  redirect(`/${org}/repos/${repoId}`);
}
