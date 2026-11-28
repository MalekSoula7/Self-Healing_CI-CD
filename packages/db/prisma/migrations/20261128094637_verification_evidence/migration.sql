-- AlterTable
ALTER TABLE "HealAttempt" ADD COLUMN     "ciFailedAt" TIMESTAMP(3),
ADD COLUMN     "ciSeen" INTEGER NOT NULL DEFAULT 0;
