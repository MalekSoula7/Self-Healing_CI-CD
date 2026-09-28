-- CreateEnum
CREATE TYPE "FailureStatus" AS ENUM ('DETECTED', 'TRIAGED', 'SKIPPED', 'FLAKY', 'QUEUED', 'HEALING', 'PR_OPENED', 'VERIFIED', 'UNVERIFIED', 'NEEDS_HUMAN', 'NEEDS_SETUP', 'NOT_REPRODUCIBLE', 'FAILED');

-- CreateEnum
CREATE TYPE "FailureCategory" AS ENUM ('COMPILE', 'TYPECHECK', 'LINT', 'TEST', 'DEPENDENCY', 'BUILD', 'INFRA', 'CONFIG', 'FLAKY', 'UNKNOWN');

-- CreateTable
CREATE TABLE "PipelineFailure" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "repoId" UUID NOT NULL,
    "headSha" TEXT NOT NULL,
    "headBranch" TEXT,
    "status" "FailureStatus" NOT NULL DEFAULT 'DETECTED',
    "category" "FailureCategory",
    "confidence" DOUBLE PRECISION,
    "summary" TEXT,
    "skipReason" TEXT,
    "windowClosesAt" TIMESTAMP(3) NOT NULL,
    "windowClosedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelineFailure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FailedRun" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "repoId" UUID NOT NULL,
    "failureId" UUID NOT NULL,
    "runId" BIGINT NOT NULL,
    "runAttempt" INTEGER NOT NULL,
    "workflowId" BIGINT NOT NULL,
    "workflowName" TEXT NOT NULL,
    "workflowPath" TEXT NOT NULL,
    "conclusion" TEXT NOT NULL,
    "htmlUrl" TEXT,
    "rerunByUs" BOOLEAN NOT NULL DEFAULT false,
    "lateArrival" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FailedRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FailedJob" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "failedRunId" UUID NOT NULL,
    "githubJobId" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "failedStep" TEXT,
    "htmlUrl" TEXT,
    "category" "FailureCategory",
    "confidence" DOUBLE PRECISION,
    "summary" TEXT,
    "errorWindow" TEXT,
    "signals" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FailedJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PipelineFailure_orgId_createdAt_idx" ON "PipelineFailure"("orgId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineFailure_repoId_headSha_key" ON "PipelineFailure"("repoId", "headSha");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineFailure_orgId_id_key" ON "PipelineFailure"("orgId", "id");

-- CreateIndex
CREATE INDEX "FailedRun_orgId_createdAt_idx" ON "FailedRun"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "FailedRun_failureId_idx" ON "FailedRun"("failureId");

-- CreateIndex
CREATE UNIQUE INDEX "FailedRun_repoId_runId_key" ON "FailedRun"("repoId", "runId");

-- CreateIndex
CREATE UNIQUE INDEX "FailedRun_orgId_id_key" ON "FailedRun"("orgId", "id");

-- CreateIndex
CREATE INDEX "FailedJob_orgId_createdAt_idx" ON "FailedJob"("orgId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FailedJob_failedRunId_githubJobId_key" ON "FailedJob"("failedRunId", "githubJobId");

-- AddForeignKey
ALTER TABLE "PipelineFailure" ADD CONSTRAINT "PipelineFailure_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineFailure" ADD CONSTRAINT "PipelineFailure_orgId_repoId_fkey" FOREIGN KEY ("orgId", "repoId") REFERENCES "Repository"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FailedRun" ADD CONSTRAINT "FailedRun_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FailedRun" ADD CONSTRAINT "FailedRun_orgId_repoId_fkey" FOREIGN KEY ("orgId", "repoId") REFERENCES "Repository"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FailedRun" ADD CONSTRAINT "FailedRun_orgId_failureId_fkey" FOREIGN KEY ("orgId", "failureId") REFERENCES "PipelineFailure"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FailedJob" ADD CONSTRAINT "FailedJob_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FailedJob" ADD CONSTRAINT "FailedJob_orgId_failedRunId_fkey" FOREIGN KEY ("orgId", "failedRunId") REFERENCES "FailedRun"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
