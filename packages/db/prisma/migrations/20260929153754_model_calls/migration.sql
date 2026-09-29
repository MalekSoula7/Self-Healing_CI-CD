-- CreateTable
CREATE TABLE "ModelCall" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "failureId" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6) NOT NULL,
    "outcome" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModelCall_orgId_createdAt_idx" ON "ModelCall"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "ModelCall_failureId_idx" ON "ModelCall"("failureId");

-- AddForeignKey
ALTER TABLE "ModelCall" ADD CONSTRAINT "ModelCall_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelCall" ADD CONSTRAINT "ModelCall_orgId_failureId_fkey" FOREIGN KEY ("orgId", "failureId") REFERENCES "PipelineFailure"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
