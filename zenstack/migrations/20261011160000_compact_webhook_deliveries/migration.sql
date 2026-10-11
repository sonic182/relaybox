-- AlterTable
ALTER TABLE "WebhookDelivery" ALTER COLUMN "payload" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_createdAt_idx" ON "WebhookDelivery"("status", "createdAt");
