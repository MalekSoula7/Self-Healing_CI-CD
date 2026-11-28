import Link from "next/link";
import { Button } from "@/components/ui/button";
import { requireOrgMember } from "@/lib/auth/session";

// The metrics dashboard SPEC describes is P6.1; for now this just points at repository
// management, the only thing there is to manage before then.
export default async function OrgDashboardPage({ params }: PageProps<"/[org]">) {
  const { org } = await params;
  // Pages check too: a layout doesn't re-run on every client-side navigation.
  await requireOrgMember(org);

  return (
    <main className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{org}</h1>
      <div>
        <Button asChild>
          <Link href={`/${org}/repos`}>Repositories</Link>
        </Button>
      </div>
    </main>
  );
}
