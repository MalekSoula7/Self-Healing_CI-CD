"use server";

import { redirect } from "next/navigation";
import { requireOrgMember } from "@/lib/auth/session";
import { stringField } from "@/lib/form";

export async function setRepositoryEnabled(formData: FormData): Promise<void> {
  const org = stringField(formData, "org");
  const repoId = stringField(formData, "repoId");
  const enabled = formData.get("enabled") === "true";
  const scope = await requireOrgMember(org, "ADMIN");
  await scope.repositories.setEnabled(repoId, enabled);
  redirect(`/${org}/repos`);
}
