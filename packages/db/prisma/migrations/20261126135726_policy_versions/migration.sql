-- CreateEnum
CREATE TYPE "PolicyKind" AS ENUM ('ORG_DEFAULT', 'ORG_GUARDRAIL', 'REPO');

-- CreateTable
CREATE TABLE "PolicyVersion" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "kind" "PolicyKind" NOT NULL,
    "repoId" UUID,
    "target" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "rules" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PolicyVersion_orgId_kind_target_createdAt_idx" ON "PolicyVersion"("orgId", "kind", "target", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyVersion_orgId_kind_target_version_key" ON "PolicyVersion"("orgId", "kind", "target", "version");

-- AddForeignKey
ALTER TABLE "PolicyVersion" ADD CONSTRAINT "PolicyVersion_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyVersion" ADD CONSTRAINT "PolicyVersion_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
