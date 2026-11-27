-- CreateEnum
CREATE TYPE "AgentStepStatus" AS ENUM ('PENDING', 'READY', 'DONE');

-- CreateEnum
CREATE TYPE "AgentEventType" AS ENUM ('MODEL_CALL', 'TOOL_CALL', 'TOOL_RESULT', 'POLICY_CHECK', 'INFO');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AttemptStatus" ADD VALUE 'AWAITING_SUBMISSION';
ALTER TYPE "AttemptStatus" ADD VALUE 'NOT_REPRODUCIBLE';
ALTER TYPE "AttemptStatus" ADD VALUE 'GAVE_UP';

-- AlterTable
ALTER TABLE "HealAttempt" ADD COLUMN     "endReason" TEXT,
ADD COLUMN     "iterations" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "AgentStep" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "stepSeq" INTEGER NOT NULL,
    "status" "AgentStepStatus" NOT NULL DEFAULT 'PENDING',
    "requestHash" TEXT NOT NULL,
    "toolCalls" JSONB,
    "outcome" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentEvent" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "stepSeq" INTEGER NOT NULL,
    "type" "AgentEventType" NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentStep_orgId_createdAt_idx" ON "AgentStep"("orgId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentStep_attemptId_stepSeq_key" ON "AgentStep"("attemptId", "stepSeq");

-- CreateIndex
CREATE UNIQUE INDEX "AgentStep_orgId_id_key" ON "AgentStep"("orgId", "id");

-- CreateIndex
CREATE INDEX "AgentEvent_orgId_createdAt_idx" ON "AgentEvent"("orgId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentEvent_attemptId_seq_key" ON "AgentEvent"("attemptId", "seq");

-- AddForeignKey
ALTER TABLE "AgentStep" ADD CONSTRAINT "AgentStep_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentStep" ADD CONSTRAINT "AgentStep_orgId_attemptId_fkey" FOREIGN KEY ("orgId", "attemptId") REFERENCES "HealAttempt"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentEvent" ADD CONSTRAINT "AgentEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentEvent" ADD CONSTRAINT "AgentEvent_orgId_attemptId_fkey" FOREIGN KEY ("orgId", "attemptId") REFERENCES "HealAttempt"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
