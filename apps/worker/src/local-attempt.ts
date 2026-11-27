// Local mode's attempt (P4.6, SPEC §12): a real attempt with a real session, made through the same
// helpers as production, so the gateway treats the local runner like any other. There is no auth
// bypass: the CLI gets the session token that `runnerSessions.open` stored the hash of, exactly as
// POST /v1/session would after verifying an OIDC token (the step the CLI can't do: it has no
// GitHub Actions job). The org and repository are local ones, with fixed fake GitHub IDs.
import { createHash, randomBytes, randomInt } from "node:crypto";
import { forSystem, installations, runnerSessions, type Db } from "@pipeheal/db";
import {
  sessionResponseSchema,
  type AttemptCommands,
  type CheckName,
  type SessionResponse,
} from "@pipeheal/shared/protocol";
import { hashSessionToken } from "./gateway/session";

export const LOCAL_ORG = {
  githubAccountId: 990_000_000_001n,
  installationId: 990_000_000_002n,
  login: "pipeheal-local",
} as const;

/** The session's wall clock in local mode. */
const LOCAL_WALL_CLOCK_MINUTES = 25;

export interface LocalAttemptInput {
  /** The demo repository's name, e.g. "demo-node". */
  repoName: string;
  targetSha: string;
  failingCheck: Exclude<CheckName, "test_file">;
  commands: AttemptCommands;
  junitGlob: string | null;
}

export interface LocalAttempt {
  orgId: string;
  attemptId: string;
  /** For the local runner only; never printed. */
  sessionToken: string;
  session: SessionResponse;
}

/** A stable fake GitHub repository ID per name, above anything GitHub hands out today. */
export function localRepoId(name: string): bigint {
  const digest = createHash("sha256").update(name).digest();
  return 990_000_001_000n + BigInt(digest.readUInt32BE(0) % 1_000_000);
}

export async function createLocalAttempt(db: Db, input: LocalAttemptInput): Promise<LocalAttempt> {
  const org = await installations(db, "local-mode").upsert({
    githubAccountId: LOCAL_ORG.githubAccountId,
    login: LOCAL_ORG.login,
    accountType: "ORG",
    installationId: LOCAL_ORG.installationId,
  });
  const system = await forSystem(db, org.id, "local-mode");
  const githubRepoId = localRepoId(input.repoName);
  const fullName = `${LOCAL_ORG.login}/${input.repoName}`;
  const [repo] = await system.repositories.syncInstalled([
    { githubRepoId, fullName, defaultBranch: "main" },
  ]);
  if (repo === undefined) throw new Error("the local repository wasn't created");
  await system.repositories.setEnabled(repo.id, true);
  await system.repositories.setCommands(repo.id, {
    commands: input.commands,
    junitGlob: input.junitGlob,
  });

  const runId = BigInt(randomInt(1, 2 ** 47));
  const { failure } = await system.failures.recordFailedRun(repo.id, {
    headSha: input.targetSha,
    headBranch: "local",
    runId,
    runAttempt: 1,
    workflowId: 1n,
    workflowName: "local",
    workflowPath: ".github/workflows/ci.yml",
    conclusion: "failure",
    htmlUrl: `https://github.com/${fullName}/actions/runs/${String(runId)}`,
    jobs: [
      {
        githubJobId: BigInt(randomInt(1, 2 ** 47)),
        name: input.failingCheck,
        failedStep: input.failingCheck,
        htmlUrl: null,
      },
    ],
  });
  const attempt = await system.attempts.create({
    failureId: failure.id,
    targetSha: input.targetSha,
    failingCheck: input.failingCheck,
    dispatchRunId: BigInt(randomInt(1, 2 ** 47)),
  });

  const sessionToken = randomBytes(32).toString("base64url");
  const opened = await runnerSessions(db, "local-mode").open(
    { attemptId: attempt.id, githubRepoId, githubOwnerId: LOCAL_ORG.githubAccountId },
    {
      tokenHash: hashSessionToken(sessionToken),
      now: new Date(),
      ttlMs: LOCAL_WALL_CLOCK_MINUTES * 60_000,
    },
  );
  if (opened === null) throw new Error("the local attempt's session didn't open");
  return {
    orgId: org.id,
    attemptId: attempt.id,
    sessionToken,
    session: sessionResponseSchema.parse({
      sessionToken,
      expiresAt: opened.expiresAt.toISOString(),
      attempt: {
        targetSha: input.targetSha,
        failingCheck: input.failingCheck,
        commands: input.commands,
        junitGlob: input.junitGlob,
        wallClockMinutes: LOCAL_WALL_CLOCK_MINUTES,
      },
    }),
  };
}
