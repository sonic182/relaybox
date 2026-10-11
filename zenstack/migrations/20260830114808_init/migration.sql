-- CreateTable
CREATE TABLE "InstanceRecord" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "connectionStatus" TEXT NOT NULL DEFAULT 'close',
    "ownerJid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "connectedAt" TIMESTAMP(3),

    CONSTRAINT "InstanceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookConfig" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "headers" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "events" JSONB NOT NULL,
    "webhookByEvents" BOOLEAN NOT NULL DEFAULT false,
    "webhookBase64" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "instanceId" TEXT NOT NULL,

    CONSTRAINT "WebhookConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chat" (
    "id" TEXT NOT NULL,
    "remoteJid" TEXT NOT NULL,
    "name" TEXT,
    "unreadMessages" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3),
    "lastMessagePreview" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "instanceId" TEXT NOT NULL,

    CONSTRAINT "Chat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "remoteJid" TEXT NOT NULL,
    "fromMe" BOOLEAN NOT NULL,
    "participant" TEXT,
    "pushName" TEXT,
    "messageType" TEXT NOT NULL,
    "messageTimestamp" INTEGER NOT NULL,
    "status" TEXT,
    "content" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "instanceId" TEXT NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "responseStatus" INTEGER,
    "lastError" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "instanceId" TEXT NOT NULL,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InstanceRecord_name_key" ON "InstanceRecord"("name");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookConfig_instanceId_key" ON "WebhookConfig"("instanceId");

-- CreateIndex
CREATE INDEX "Chat_instanceId_lastMessageAt_idx" ON "Chat"("instanceId", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "Chat_instanceId_remoteJid_key" ON "Chat"("instanceId", "remoteJid");

-- CreateIndex
CREATE INDEX "Message_instanceId_remoteJid_messageTimestamp_idx" ON "Message"("instanceId", "remoteJid", "messageTimestamp");

-- CreateIndex
CREATE UNIQUE INDEX "Message_instanceId_remoteJid_fromMe_keyId_key" ON "Message"("instanceId", "remoteJid", "fromMe", "keyId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_dedupeKey_key" ON "WebhookDelivery"("dedupeKey");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "WebhookConfig" ADD CONSTRAINT "WebhookConfig_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "InstanceRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "InstanceRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "InstanceRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "InstanceRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
