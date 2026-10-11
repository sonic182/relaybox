CREATE TABLE "BaileysAuthState" (
    "instanceId" TEXT NOT NULL,
    "creds" JSONB NOT NULL,
    "keys" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BaileysAuthState_pkey" PRIMARY KEY ("instanceId")
);

ALTER TABLE "BaileysAuthState" ADD CONSTRAINT "BaileysAuthState_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "InstanceRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
