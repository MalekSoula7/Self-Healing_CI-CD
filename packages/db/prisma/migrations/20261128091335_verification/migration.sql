-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AttemptStatus" ADD VALUE 'VERIFIED';
ALTER TYPE "AttemptStatus" ADD VALUE 'CI_FAILED';
ALTER TYPE "AttemptStatus" ADD VALUE 'UNVERIFIED';

-- AlterTable
ALTER TABLE "HealAttempt" ADD COLUMN     "prOpenedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "HealAttempt_orgId_commitSha_idx" ON "HealAttempt"("orgId", "commitSha");
