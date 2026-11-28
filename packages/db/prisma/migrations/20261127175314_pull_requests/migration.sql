-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AttemptStatus" ADD VALUE 'PUBLISHING';
ALTER TYPE "AttemptStatus" ADD VALUE 'PR_OPENED';

-- AlterTable
ALTER TABLE "HealAttempt" ADD COLUMN     "branch" TEXT,
ADD COLUMN     "commitSha" TEXT,
ADD COLUMN     "draft" BOOLEAN,
ADD COLUMN     "prNumber" INTEGER,
ADD COLUMN     "prUrl" TEXT;

-- CreateTable
CREATE TABLE "HealBranch" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "repoId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "lastCommitSha" TEXT NOT NULL,
    "attemptId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealBranch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HealBranch_orgId_createdAt_idx" ON "HealBranch"("orgId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "HealBranch_repoId_name_key" ON "HealBranch"("repoId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "HealBranch_orgId_id_key" ON "HealBranch"("orgId", "id");

-- AddForeignKey
ALTER TABLE "HealBranch" ADD CONSTRAINT "HealBranch_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealBranch" ADD CONSTRAINT "HealBranch_orgId_repoId_fkey" FOREIGN KEY ("orgId", "repoId") REFERENCES "Repository"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
