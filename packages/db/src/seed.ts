// Demo data for a local development database (`pnpm db:seed`). Idempotent: rows are upserted by
// their natural keys and never overwritten, so changes made in the UI survive a re-seed.
//
// GitHub IDs here are negative. Real GitHub IDs are positive, so seeded rows can never collide
// with a real account, installation, repository or workflow once the dev App is installed.
import { isLoopbackUrl } from "@pipeheal/shared";
import type { Db } from "./client";
import type { Prisma } from "./generated/prisma/client";
import { jobSignalsSchema, recentChangesRecordSchema } from "./inputs";

export const SEED_ORG_SLUG = "pipeheal-demo";
export const SEED_USER_EMAIL = "demo-owner@pipeheal.invalid";

/** Demo data only ever goes into a local development database. */
export function assertSeedable(databaseUrl: string, nodeEnv: string | undefined): void {
  if (nodeEnv === "production" || !isLoopbackUrl(databaseUrl)) {
    throw new Error("Refusing to seed: demo data goes into a local development database only.");
  }
}

interface SeedWorkflow {
  githubWorkflowId: bigint;
  path: string;
  name: string;
  selected: boolean;
  usesEnvironment: boolean;
  triggers: string[];
}

interface SeedRepository {
  githubRepoId: bigint;
  name: string;
  enabled: boolean;
  language: string;
  commands: Prisma.InputJsonObject;
  junitGlob: string;
  workflows: SeedWorkflow[];
}

const REPOSITORIES: SeedRepository[] = [
  {
    githubRepoId: -1n,
    name: "demo-node",
    enabled: true,
    language: "TypeScript",
    commands: {
      install: ["pnpm", "install", "--frozen-lockfile"],
      build: ["pnpm", "build"],
      lint: ["pnpm", "lint"],
      typecheck: ["pnpm", "typecheck"],
      test: ["pnpm", "test"],
    },
    junitGlob: "reports/junit.xml",
    workflows: [
      {
        githubWorkflowId: -1n,
        path: ".github/workflows/ci.yml",
        name: "CI",
        selected: true,
        usesEnvironment: false,
        triggers: ["push", "pull_request"],
      },
      {
        githubWorkflowId: -2n,
        path: ".github/workflows/deploy.yml",
        name: "Deploy",
        selected: false,
        usesEnvironment: true,
        triggers: ["push"],
      },
    ],
  },
  {
    githubRepoId: -2n,
    name: "demo-python",
    enabled: false,
    language: "Python",
    commands: {
      install: ["pip", "install", "-r", "requirements.txt"],
      lint: ["ruff", "check", "."],
      typecheck: ["mypy", "."],
      test: ["pytest", "--junitxml=reports/junit.xml"],
    },
    junitGlob: "reports/junit.xml",
    workflows: [
      {
        githubWorkflowId: -3n,
        path: ".github/workflows/ci.yml",
        name: "CI",
        selected: true,
        usesEnvironment: false,
        triggers: ["push", "pull_request"],
      },
    ],
  },
];

export async function seed(db: Db): Promise<void> {
  await db.$transaction(async (tx) => {
    const user = await tx.user.upsert({
      where: { email: SEED_USER_EMAIL },
      update: {},
      create: {
        id: "seed-demo-owner",
        name: "Demo Owner",
        email: SEED_USER_EMAIL,
        login: "demo-owner",
      },
    });

    const org = await tx.organization.upsert({
      where: { githubAccountId: -1n },
      update: {},
      create: {
        githubAccountId: -1n,
        login: SEED_ORG_SLUG,
        slug: SEED_ORG_SLUG,
        accountType: "ORG",
        installationId: -1n,
      },
    });

    await tx.membership.upsert({
      where: { orgId_userId: { orgId: org.id, userId: user.id } },
      update: {},
      create: { orgId: org.id, userId: user.id, role: "OWNER" },
    });

    for (const { workflows, name, ...repo } of REPOSITORIES) {
      const repository = await tx.repository.upsert({
        where: { orgId_githubRepoId: { orgId: org.id, githubRepoId: repo.githubRepoId } },
        update: {},
        create: {
          ...repo,
          orgId: org.id,
          fullName: `${SEED_ORG_SLUG}/${name}`,
          defaultBranch: "main",
        },
      });
      for (const workflow of workflows) {
        await tx.repoWorkflow.upsert({
          where: {
            repoId_githubWorkflowId: {
              repoId: repository.id,
              githubWorkflowId: workflow.githubWorkflowId,
            },
          },
          update: {},
          create: { ...workflow, orgId: org.id, repoId: repository.id },
        });
      }
    }

    const demoNode = await tx.repository.findUniqueOrThrow({
      where: { orgId_githubRepoId: { orgId: org.id, githubRepoId: -1n } },
    });
    await seedFailure(tx, org.id, demoNode.id);

    const alreadySeeded = await tx.auditLog.findFirst({
      where: { orgId: org.id, action: "org.seeded" },
    });
    if (alreadySeeded === null) {
      await tx.auditLog.create({
        data: {
          orgId: org.id,
          actorType: "SYSTEM",
          actorId: "seed",
          action: "org.seeded",
          target: `organization:${org.id}`,
        },
      });
    }
  });
}

export const SEED_FAILURE_SHA = "5eed".repeat(10);

/** A triaged typecheck failure on demo-node, as the worker stores one (SPEC §6.2), for the UI. */
async function seedFailure(tx: Prisma.TransactionClient, orgId: string, repoId: string) {
  const signals = jobSignalsSchema.parse({
    failedStep: "Typecheck",
    exitCode: 2,
    tools: ["tsc"],
    diagnostics: [
      {
        tool: "tsc",
        severity: "error",
        code: "TS2305",
        message: "Module '\"./cart\"' has no exported member 'lineTotal'.",
        path: "src/receipt.ts",
        line: 1,
        column: 10,
      },
    ],
    failingTests: [],
    locations: [{ path: "src/receipt.ts", line: 1, column: 10 }],
    errorCodes: ["TS2305"],
  });
  const recentChanges = recentChangesRecordSchema.parse({
    base: { sha: "9e11".repeat(10), source: "same-branch", branch: "main", runId: null },
    changes: {
      totalCommits: 1,
      commits: [
        { sha: SEED_FAILURE_SHA, subject: "refactor: rename lineTotal", authorLogin: "demo-owner" },
      ],
      omittedCommits: 0,
      totalFiles: 1,
      files: [
        {
          path: "src/cart.ts",
          previousPath: null,
          status: "modified",
          additions: 1,
          deletions: 1,
          priority: false,
          patch:
            "@@ -1,3 +1,3 @@\n-export function lineTotal(item: Item): number {\n+export function lineTotals(item: Item): number {\n   return item.price * item.quantity;\n }",
          patchState: "full",
        },
      ],
      omittedFiles: 0,
      githubTruncated: false,
      estimatedTokens: 80,
      tokenBudget: 12_000,
      redactions: {},
    },
  });

  const failure = await tx.pipelineFailure.upsert({
    where: { repoId_headSha: { repoId, headSha: SEED_FAILURE_SHA } },
    update: {},
    create: {
      orgId,
      repoId,
      headSha: SEED_FAILURE_SHA,
      headBranch: "main",
      status: "TRIAGED",
      category: "TYPECHECK",
      confidence: 0.95,
      summary:
        "tsc TS2305: Module '\"./cart\"' has no exported member 'lineTotal'. (src/receipt.ts:1)",
      windowClosesAt: new Date(),
      windowClosedAt: new Date(),
      recentChanges,
    },
  });
  const run = await tx.failedRun.upsert({
    where: { repoId_runId: { repoId, runId: -1n } },
    update: {},
    create: {
      orgId,
      repoId,
      failureId: failure.id,
      runId: -1n,
      runAttempt: 1,
      workflowId: -1n,
      workflowName: "CI",
      workflowPath: ".github/workflows/ci.yml",
      conclusion: "failure",
    },
  });
  await tx.failedJob.upsert({
    where: { failedRunId_githubJobId: { failedRunId: run.id, githubJobId: -1n } },
    update: {},
    create: {
      orgId,
      failedRunId: run.id,
      githubJobId: -1n,
      name: "check",
      failedStep: "Typecheck",
      category: "TYPECHECK",
      confidence: 0.95,
      summary: failure.summary,
      errorWindow: [
        "Run npm run typecheck",
        "src/receipt.ts:1:10 - error TS2305: Module '\"./cart\"' has no exported member 'lineTotal'.",
        "##[error]Process completed with exit code 2.",
      ].join("\n"),
      signals,
    },
  });
}
