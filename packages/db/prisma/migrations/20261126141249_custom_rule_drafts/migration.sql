-- CreateEnum
CREATE TYPE "RuleDraftStatus" AS ENUM ('PENDING', 'COMPILED', 'FAILED', 'ACCEPTED', 'DISCARDED');

-- CreateTable
CREATE TABLE "CustomRuleDraft" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "kind" "PolicyKind" NOT NULL,
    "repoId" UUID,
    "target" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" "RuleDraftStatus" NOT NULL DEFAULT 'PENDING',
    "compiled" JSONB,
    "explanation" TEXT,
    "error" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomRuleDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomRuleDraft_orgId_kind_target_createdAt_idx" ON "CustomRuleDraft"("orgId", "kind", "target", "createdAt");

-- AddForeignKey
ALTER TABLE "CustomRuleDraft" ADD CONSTRAINT "CustomRuleDraft_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomRuleDraft" ADD CONSTRAINT "CustomRuleDraft_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
