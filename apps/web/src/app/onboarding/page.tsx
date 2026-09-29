import Link from "next/link";
import { githubAppInstallUrl, webEnv } from "@/env";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";

// The start of SPEC §11's onboarding flow: install the App, then GitHub redirects to
// /onboarding/installed (the App's configured Setup URL) to continue.
export default async function OnboardingPage() {
  await requireUser("/onboarding");
  const installUrl = githubAppInstallUrl(webEnv());

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-24">
      <h1 className="text-2xl font-semibold tracking-tight">Install the GitHub App</h1>
      <p className="text-muted-foreground">
        PipeHeal watches the repositories you choose during installation, and only the workflows you
        select afterward.
      </p>
      {installUrl === null ? (
        <p className="text-sm text-muted-foreground">
          Installing isn&apos;t configured yet: the App isn&apos;t registered on this deployment.
        </p>
      ) : (
        <div>
          <Button asChild>
            <Link href={installUrl}>Install GitHub App</Link>
          </Button>
        </div>
      )}
    </main>
  );
}
