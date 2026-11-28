-- AlterTable
ALTER TABLE "Repository" ADD COLUMN     "policyFile" JSONB,
ADD COLUMN     "policyFileCommitSha" TEXT,
ADD COLUMN     "policyFileErrors" JSONB,
ADD COLUMN     "policyFileReadAt" TIMESTAMP(3);
