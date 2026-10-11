-- CreateTable
CREATE TABLE "SendRequest" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "instanceId" TEXT NOT NULL,

    CONSTRAINT "SendRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SendRequest_instanceId_idempotencyKey_key" ON "SendRequest"("instanceId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "SendRequest" ADD CONSTRAINT "SendRequest_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "InstanceRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
