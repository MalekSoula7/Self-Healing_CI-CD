"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth/server";
import { safeNextPath } from "@/lib/safe-redirect";

export async function signInWithGitHub(formData: FormData): Promise<void> {
  const auth = getAuth();
  if (auth === null) redirect("/login");
  const next = safeNextPath(formData.get("next"));
  const { url } = await auth.api.signInSocial({
    body: {
      provider: "github",
      callbackURL: `/auth/complete?next=${encodeURIComponent(next)}`,
      errorCallbackURL: "/login",
    },
    headers: await headers(),
  });
  if (url === undefined) redirect("/login?error=unavailable");
  redirect(url);
}

export async function signOut(): Promise<void> {
  const auth = getAuth();
  if (auth !== null) await auth.api.signOut({ headers: await headers() });
  redirect("/login");
}
