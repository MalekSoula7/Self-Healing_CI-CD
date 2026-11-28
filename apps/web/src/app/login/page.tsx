import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { getSessionUser } from "@/lib/auth/session";
import { getAuth } from "@/lib/auth/server";
import { safeNextPath } from "@/lib/safe-redirect";
import { signInWithGitHub } from "./actions";

// Error codes Better Auth adds to the URL; anything else gets the generic message.
const ERRORS: Record<string, string> = {
  email_not_found: "GitHub didn't share an email address for your account.",
  account_not_linked: "This email already belongs to another PipeHeal account.",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { next, error } = await searchParams;
  const nextPath = safeNextPath(next);
  if ((await getSessionUser()) !== null) redirect(nextPath);
  const configured = getAuth() !== null;
  const errorMessage =
    typeof error === "string" ? (ERRORS[error] ?? "Sign-in failed. Please try again.") : null;

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 px-6 py-24">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in to PipeHeal</h1>
      {errorMessage === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage}
        </p>
      )}
      {configured ? (
        <form action={signInWithGitHub}>
          <input type="hidden" name="next" value={nextPath} />
          <Button type="submit">Sign in with GitHub</Button>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">
          GitHub sign-in isn&apos;t configured yet: set BETTER_AUTH_SECRET, GITHUB_CLIENT_ID and
          GITHUB_CLIENT_SECRET (docs/SETUP-GITHUB-APP.md).
        </p>
      )}
    </main>
  );
}
