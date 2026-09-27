import { Button } from "@/components/ui/button";

export default function HomePage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-24">
      <h1 className="text-3xl font-semibold tracking-tight">PipeHeal</h1>
      <p className="text-muted-foreground">
        Diagnoses failing GitHub Actions runs and proposes fixes as pull requests, within the rules
        your team sets. A human always merges.
      </p>
      <div>
        <Button disabled>Sign in with GitHub</Button>
      </div>
    </main>
  );
}
