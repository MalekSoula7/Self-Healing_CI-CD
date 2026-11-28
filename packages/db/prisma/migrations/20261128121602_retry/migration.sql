-- AlterTable
ALTER TABLE "HealAttempt" ADD COLUMN     "feedback" JSONB,
ADD COLUMN     "retryOfId" UUID;
