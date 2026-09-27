// @pipeheal/github: GitHub App client (Octokit) with typed, validated wrappers. Writes are
// guarded by the product invariants in ./guards.ts; there is no way to merge.
export {
  createGitHubApp,
  type GitHubApp,
  type GitHubAppConfig,
  type InstallationClient,
} from "./app";
export { GitHubApiError, USER_AGENT, type GitHubClientOptions, type GitHubLog } from "./client";
export {
  PrivateKeyError,
  decodePrivateKey,
  githubAppIdSchema,
  githubPrivateKeySchema,
  webhookSecretSchema,
} from "./credentials";
export {
  GuardError,
  HEAL_BRANCH_PREFIX,
  assertBranchName,
  assertCommitMessage,
  assertHealBranch,
  assertRepoPath,
  assertWritablePath,
  isHealBranch,
  parseFullName,
} from "./guards";
export { COMPARE_FILE_LIMIT, MAX_FILE_BYTES } from "./repo";
export type {
  Comparison,
  FileAtRef,
  FileChange,
  Job,
  JobLog,
  PullRequest,
  RepoClient,
  Workflow,
  WorkflowRun,
} from "./repo";
export { listUserInstallationIds } from "./user";
export { verifyWebhookSignature } from "./webhooks";
