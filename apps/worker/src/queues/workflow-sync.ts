// Discovers a repository's workflows (SPEC §11): when it joins the installation (P1.6), and when a
// run arrives from a workflow we don't know yet (P2.1: workflows added after the repo was synced).
import type { Repository, SystemScope } from "@pipeheal/db";
import type { RepoClient, Workflow } from "@pipeheal/github";
import type { Logger } from "@pipeheal/shared/logger";
import { isCiLooking, parseWorkflowYaml, type WorkflowFacts } from "./workflow-yaml";

/** Upserts the repository's workflows, with the CI-looking pre-selection for new ones. */
export async function syncRepoWorkflows(
  system: SystemScope,
  repoClient: RepoClient,
  repo: Pick<Repository, "id" | "defaultBranch">,
  log: Logger,
): Promise<void> {
  const workflows = await repoClient.listWorkflows();
  const facts = await workflowFacts(repoClient, repo.defaultBranch, workflows, log);
  await system.workflows.syncInstalled(
    repo.id,
    workflows.map((workflow) => {
      const known = facts.get(workflow.id);
      return {
        githubWorkflowId: workflow.id,
        path: workflow.path,
        name: workflow.name,
        ...known,
        // Only meaningful the moment a workflow is first discovered (syncInstalled ignores it
        // afterward); omitted when facts couldn't be determined, so a brand-new workflow just
        // starts unselected like any other unknown.
        ...(known === undefined
          ? {}
          : { selected: isCiLooking({ ...known, name: workflow.name, path: workflow.path }) }),
      };
    }),
  );
}

/**
 * Each workflow's triggers and `environment:` use (SPEC §11's pre-selection heuristic, §6.2
 * step 8's re-run guard), read from the file at the repo's default branch. Missing from the
 * result for any workflow whose content couldn't be fetched or didn't parse: the caller then
 * keeps whatever facts it already had, rather than overwriting them with empty defaults.
 */
async function workflowFacts(
  repoClient: RepoClient,
  defaultBranch: string,
  workflows: readonly Workflow[],
  log: Logger,
): Promise<Map<bigint, WorkflowFacts>> {
  const facts = new Map<bigint, WorkflowFacts>();
  if (workflows.length === 0) return facts;
  const headSha = await repoClient.getBranchSha(defaultBranch);
  if (headSha === null) {
    log.warn({ defaultBranch }, "default branch not found; keeping known workflow facts");
    return facts;
  }
  for (const workflow of workflows) {
    const file = await repoClient.getFileAtRef(workflow.path, headSha);
    const parsed = file?.kind === "text" ? parseWorkflowYaml(file.content) : null;
    if (parsed !== null) facts.set(workflow.id, parsed);
  }
  return facts;
}
