import {
  installationDeliveryState,
  installations,
  type InstallationDeliveryState,
} from "@pipeheal/db";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { runOwnerBindingCheck } from "@/lib/auth/owner-binding";
import { getAuth } from "@/lib/auth/server";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { getLogger } from "@/lib/logger";

// The GitHub App's Setup URL (docs/SETUP-GITHUB-APP.md): where GitHub sends the browser back
// after installing (or updating) the App, with `installation_id` and `setup_action` in the
// query string (no OAuth code: "Request user authorization during installation" is off).
export default async function OnboardingInstalledPage({
  searchParams,
}: PageProps<"/onboarding/installed">) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") query.set(key, value);
  }
  const here = `/onboarding/installed${query.size > 0 ? `?${query.toString()}` : ""}`;
  const user = await requireUser(here);

  const installationId = parsePositiveBigInt(params.installation_id);
  if (installationId !== null) {
    const auth = getAuth();
    if (auth !== null) {
      const logger = getLogger().child({ component: "owner-binding" });
      // A verified OWNER may exist for the first time only after this install; binding here
      // means they don't have to sign in again to be recognized (SPEC §5.2).
      await runOwnerBindingCheck(getDb(), auth, await headers(), user.id, logger);
    }
    const org = await installations(getDb(), "onboarding").findByInstallationId(installationId);
    if (org !== null) redirect(`/${org.slug}/repos`);
  }
  const state =
    installationId === null ? null : await installationDeliveryState(getDb(), installationId);
  if (state === "not-received" && installationId !== null) {
    // Seconds are normal; minutes mean GitHub isn't delivering to us (e.g. the App's webhook
    // is inactive), which only the operator's log can show.
    getLogger().warn({ installationId }, "onboarding: no installation webhook received yet");
  }

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-24">
      <h1 className="text-2xl font-semibold tracking-tight">Finishing setup</h1>
      <p className="text-muted-foreground">{STATUS[state ?? "not-received"]}</p>
      <div>
        <Button asChild>
          <Link href={here}>Refresh</Link>
        </Button>
      </div>
    </main>
  );
}

const STATUS: Record<InstallationDeliveryState, string> = {
  "not-received":
    "Waiting for GitHub to tell us about your installation. This usually takes a few seconds; if nothing changes within a few minutes, the problem is on our side, not yours.",
  processing: "GitHub confirmed your installation. We're setting up your repositories now.",
  failed:
    "Setting up your repositories hit a problem. We're retrying automatically; refresh in a minute.",
  processed: "Almost done: refresh to continue.",
};

function parsePositiveBigInt(value: string | string[] | undefined): bigint | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const id = BigInt(raw);
  return id > 0n ? id : null;
}
