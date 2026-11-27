-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AttemptStatus" ADD VALUE 'VALIDATING';
ALTER TYPE "AttemptStatus" ADD VALUE 'VALIDATED';
ALTER TYPE "AttemptStatus" ADD VALUE 'REJECTED';

-- AlterTable
ALTER TABLE "HealAttempt" ADD COLUMN     "validation" JSONB;

-- CreateTable
CREATE TABLE "AttemptSubmission" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "requestHash" TEXT NOT NULL,
    "files" JSONB NOT NULL,
    "checks" JSONB NOT NULL,
    "afterTests" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttemptSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AttemptSubmission_attemptId_key" ON "AttemptSubmission"("attemptId");

-- CreateIndex
CREATE INDEX "AttemptSubmission_orgId_createdAt_idx" ON "AttemptSubmission"("orgId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AttemptSubmission_orgId_id_key" ON "AttemptSubmission"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AttemptSubmission_orgId_attemptId_key" ON "AttemptSubmission"("orgId", "attemptId");

-- AddForeignKey
ALTER TABLE "AttemptSubmission" ADD CONSTRAINT "AttemptSubmission_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttemptSubmission" ADD CONSTRAINT "AttemptSubmission_orgId_attemptId_fkey" FOREIGN KEY ("orgId", "attemptId") REFERENCES "HealAttempt"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
