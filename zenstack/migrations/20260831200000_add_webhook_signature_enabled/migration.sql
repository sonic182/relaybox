-- Add an explicit signing toggle while retaining the behavior of existing signed webhooks.
ALTER TABLE "WebhookConfig" ADD COLUMN "signatureEnabled" BOOLEAN NOT NULL DEFAULT false;
UPDATE "WebhookConfig" SET "signatureEnabled" = true WHERE "signatureSecret" IS NOT NULL;
