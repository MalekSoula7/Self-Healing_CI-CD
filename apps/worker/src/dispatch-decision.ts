// Whether a triaged failure is healed (SPEC §2 step 6, P4.8): healable, in scope, and set up. Pure;
// the caps (D18) are checked by the database claim in the same transaction that creates the
// attempt (`attempts.claimDispatch`). A failure that fails a check here stays at its diagnosis:
// SKIPPED (not healable, out of scope) or NEEDS_SETUP (something the customer has to add).
import { compileGlob, globMatches, type EffectivePolicy, type ScopeGlobs } from "@pipeheal/policy";
import { attemptCommandsSchema } from "@pipeheal/shared/protocol";
import { HEALER_WORKFLOW_PATH } from "./gateway/oidc";

export type DispatchCheck = "install" | "build" | "lint" | "typecheck" | "test";

export type DispatchDecision =
  | { kind: "dispatch"; failingCheck: DispatchCheck }
  | { kind: "settle"; status: "SKIPPED" | "NEEDS_SETUP"; reason: string };

export interface DispatchFacts {
  /** As stored: SPEC §6.1's category in upper case, or null when triage found none. */
  category: string | null;
  headBranch: string | null;
  runs: readonly { workflowPath: string; conclusion: string }[];
  /** The repository's configured commands (SPEC §7.2), as stored. */
  commands: unknown;
  /** The repository's workflows on GitHub, as last synced. */
  workflows: readonly { path: string; triggers: readonly string[] }[];
}

/** A name in scope: matched by a glob of every include list, and by no exclude glob (§8.4). */
export function inScope(globs: ScopeGlobs, name: string): boolean {
  // Globs are validated when a layer is saved; one that doesn't compile matches nothing it
  // includes and everything it excludes, so a bad glob only ever narrows.
  const matches = (glob: string, otherwise: boolean) => {
    const compiled = compileGlob(glob);
    return compiled === null ? otherwise : globMatches(compiled, name);
  };
  return (
    globs.includeAll.every((list) => list.some((glob) => matches(glob, false))) &&
    !globs.exclude.some((glob) => matches(glob, true))
  );
}

/** The configured check that shows a category's failure (SPEC §6.1, §7.2). */
function checkFor(category: string, commands: Record<string, unknown>): DispatchCheck | null {
  switch (category) {
    case "lint":
    case "typecheck":
    case "test":
    case "build":
      return category;
    case "dependency":
      return "install";
    // A compile error shows when type-checking, or when building where there's no type-check.
    case "compile":
      return commands.typecheck !== undefined ? "typecheck" : "build";
    default:
      return null;
  }
}

export function dispatchDecision(facts: DispatchFacts, policy: EffectivePolicy): DispatchDecision {
  const skip = (reason: string): DispatchDecision => ({
    kind: "settle",
    status: "SKIPPED",
    reason,
  });
  const setup = (reason: string): DispatchDecision => ({
    kind: "settle",
    status: "NEEDS_SETUP",
    reason,
  });

  const category = facts.category?.toLowerCase() ?? "unknown";
  const healable: readonly string[] = policy.scope.categories;
  if (!healable.includes(category)) return skip(`category ${category} is diagnosed only`);

  const branch = facts.headBranch;
  if (branch === null) return skip("the failed runs have no branch");
  if (branch.startsWith("pipeheal/")) return skip("PipeHeal doesn't heal its own branches");
  if (!inScope(policy.scope.branches, branch))
    return skip("the branch is out of the policy's scope");

  // Every failing workflow in scope: the attempt heals the whole commit, and the failure's
  // category comes from all its jobs, so one out of scope keeps it at its diagnosis
  // (P4.8 review M3). Workflow globs match the workflow's file path.
  const failing = facts.runs.filter((run) => run.conclusion !== "success");
  if (failing.length === 0) return skip("no workflow is still failing");
  if (!failing.every((run) => inScope(policy.scope.workflows, run.workflowPath))) {
    return skip("a failing workflow is out of the policy's scope");
  }

  const healer = facts.workflows.find((workflow) => workflow.path === HEALER_WORKFLOW_PATH);
  if (healer === undefined) {
    return setup(`the healer workflow ${HEALER_WORKFLOW_PATH} isn't on the default branch`);
  }
  // No triggers known (the file wasn't parsed): GitHub refuses the dispatch itself if need be.
  if (healer.triggers.length > 0 && !healer.triggers.includes("workflow_dispatch")) {
    return setup("the healer workflow has no workflow_dispatch trigger");
  }

  const commands = attemptCommandsSchema.safeParse(facts.commands ?? {});
  if (!commands.success) return setup("the repository's commands are invalid");
  const check = checkFor(category, commands.data);
  if (check === null) return skip(`category ${category} is diagnosed only`);
  if (commands.data[check] === undefined) {
    return setup(`no ${check} command is configured for the repository`);
  }
  return { kind: "dispatch", failingCheck: check };
}
