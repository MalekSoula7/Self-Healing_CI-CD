import { organizationsOf } from "@pipeheal/db";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getSessionUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";

export default async function HomePage() {
  const user = await getSessionUser();
  const memberships = user === null ? [] : await organizationsOf(getDb(), user.id);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-24">
      <h1 className="text-3xl font-semibold tracking-tight">PipeHeal</h1>
      <p className="text-muted-foreground">
        Diagnoses failing GitHub Actions runs and proposes fixes as pull requests, within the rules
        your team sets. A human always merges.
      </p>
      {user === null ? (
        <div>
          <Button asChild>
            <Link href="/login">Sign in with GitHub</Link>
          </Button>
        </div>
      ) : memberships.length === 0 ? (
        <div className="flex flex-col gap-3">
          <p>You don&apos;t belong to an organization yet.</p>
          <div>
            <Button asChild>
              <Link href="/onboarding">Install GitHub App</Link>
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <ul className="flex flex-col gap-2">
            {memberships.map(({ org, role }) => (
              <li key={org.id}>
                <Link href={`/${org.slug}`} className="underline">
                  {org.login}
                </Link>{" "}
                <span className="text-sm text-muted-foreground">({role.toLowerCase()})</span>
              </li>
            ))}
          </ul>
          <Link href="/onboarding" className="text-sm text-muted-foreground underline">
            Install PipeHeal on another account
          </Link>
        </div>
      )}
    </main>
  );
}
