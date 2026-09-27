import Link from "next/link";
import { Button } from "@/components/ui/button";
import { requireOrgMember } from "@/lib/auth/session";
import { signOut } from "../login/actions";

export default async function OrgLayout({ children, params }: LayoutProps<"/[org]">) {
  const { org } = await params;
  const scope = await requireOrgMember(org);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-10">
      <header className="flex items-center justify-between gap-4">
        <Link href={`/${scope.org.slug}`} className="text-lg font-semibold">
          {scope.org.login}
        </Link>
        <form action={signOut}>
          <Button type="submit" variant="outline" size="sm">
            Sign out
          </Button>
        </form>
      </header>
      {children}
    </div>
  );
}
