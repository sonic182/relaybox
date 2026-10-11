-- CreateTable
CREATE TABLE "InstanceSettings" (
    "id" TEXT NOT NULL,
    "syncFullHistory" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "instanceId" TEXT NOT NULL,

    CONSTRAINT "InstanceSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InstanceSettings_instanceId_key" ON "InstanceSettings"("instanceId");

-- AddForeignKey
ALTER TABLE "InstanceSettings" ADD CONSTRAINT "InstanceSettings_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "InstanceRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
