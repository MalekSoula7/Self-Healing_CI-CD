// Demo data for a local development database (`pnpm db:seed`). Idempotent: rows are upserted by
// their natural keys and never overwritten, so changes made in the UI survive a re-seed.
//
// GitHub IDs here are negative. Real GitHub IDs are positive, so seeded rows can never collide
// with a real account, installation, repository or workflow once the dev App is installed.
import { isLoopbackUrl } from "@pipeheal/shared";
import type { Db } from "./client";
import type { Prisma } from "./generated/prisma/client";

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
      install: "pnpm install --frozen-lockfile",
      build: "pnpm build",
      lint: "pnpm lint",
      typecheck: "pnpm typecheck",
      test: "pnpm test",
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
      install: "pip install -r requirements.txt",
      lint: "ruff check .",
      typecheck: "mypy .",
      test: "pytest --junitxml=reports/junit.xml",
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
