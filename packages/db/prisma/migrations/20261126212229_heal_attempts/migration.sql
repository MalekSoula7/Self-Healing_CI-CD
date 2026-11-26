-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('DISPATCHED', 'RUNNING', 'FAILED');

-- CreateTable
CREATE TABLE "HealAttempt" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "failureId" UUID NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "status" "AttemptStatus" NOT NULL DEFAULT 'DISPATCHED',
    "targetSha" TEXT NOT NULL,
    "failingCheck" TEXT NOT NULL,
    "dispatchRunId" BIGINT,
    "dispatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sessionTokenHash" TEXT,
    "sessionOpenedAt" TIMESTAMP(3),
    "sessionExpiresAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HealAttempt_sessionTokenHash_key" ON "HealAttempt"("sessionTokenHash");

-- CreateIndex
CREATE INDEX "HealAttempt_orgId_createdAt_idx" ON "HealAttempt"("orgId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "HealAttempt_failureId_attemptNo_key" ON "HealAttempt"("failureId", "attemptNo");

-- CreateIndex
CREATE UNIQUE INDEX "HealAttempt_orgId_id_key" ON "HealAttempt"("orgId", "id");

-- AddForeignKey
ALTER TABLE "HealAttempt" ADD CONSTRAINT "HealAttempt_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealAttempt" ADD CONSTRAINT "HealAttempt_orgId_failureId_fkey" FOREIGN KEY ("orgId", "failureId") REFERENCES "PipelineFailure"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
