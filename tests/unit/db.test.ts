import { describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers';

async function seedInstance(db: ReturnType<typeof createTestDb>, name = 'acme') {
  return db.instanceRecord.create({ data: { name } });
}

describe('schema constraints', () => {
  it('keeps instance names unique', async () => {
    const db = createTestDb();
    await seedInstance(db);

    await expect(seedInstance(db)).rejects.toThrow();
  });

  it('rejects a duplicate message key for the same instance', async () => {
    const db = createTestDb();
    const instance = await seedInstance(db);
    const message = {
      instanceId: instance.id,
      keyId: '3EB0C767D26B8A3F1A2B',
      remoteJid: '5511888888888@s.whatsapp.net',
      fromMe: false,
      messageType: 'conversation',
      messageTimestamp: 1756555200,
      content: { conversation: 'hello there' },
    };

    await db.message.create({ data: message });

    await expect(db.message.create({ data: message })).rejects.toThrow();
    // The same key from the other direction is a different message.
    await expect(db.message.create({ data: { ...message, fromMe: true } })).resolves.toBeTruthy();
  });

  it('keeps one chat projection per instance and remote jid', async () => {
    const db = createTestDb();
    const instance = await seedInstance(db);
    const chat = { instanceId: instance.id, remoteJid: '5511888888888@s.whatsapp.net' };

    await db.chat.create({ data: chat });

    await expect(db.chat.create({ data: chat })).rejects.toThrow();
  });

  it('rejects a duplicate delivery dedupe key', async () => {
    const db = createTestDb();
    const instance = await seedInstance(db);
    const delivery = {
      instanceId: instance.id,
      event: 'MESSAGES_UPSERT',
      url: 'https://consumer.example/webhooks/whatsapp',
      payload: { event: 'messages.upsert' },
      dedupeKey: 'MESSAGES_UPSERT:3EB0C767D26B8A3F1A2B',
    };

    const created = await db.webhookDelivery.create({ data: delivery });
    expect(created.status).toBe('pending');
    expect(created.attempts).toBe(0);

    await expect(db.webhookDelivery.create({ data: delivery })).rejects.toThrow();
  });

  it('cascades instance deletion to its webhook, chats, messages, and deliveries', async () => {
    const db = createTestDb();
    const instance = await seedInstance(db);

    await db.webhookConfig.create({
      data: { instanceId: instance.id, url: 'https://consumer.example/hook', events: ['MESSAGES_UPSERT'] },
    });
    await db.chat.create({ data: { instanceId: instance.id, remoteJid: 'jid' } });
    await db.message.create({
      data: {
        instanceId: instance.id,
        keyId: 'k',
        remoteJid: 'jid',
        fromMe: false,
        messageType: 'conversation',
        messageTimestamp: 1,
        content: {},
      },
    });
    await db.webhookDelivery.create({
      data: {
        instanceId: instance.id,
        event: 'MESSAGES_UPSERT',
        url: 'https://consumer.example/hook',
        payload: {},
        dedupeKey: 'k',
      },
    });

    await db.instanceRecord.delete({ where: { id: instance.id } });

    expect(await db.webhookConfig.count()).toBe(0);
    expect(await db.chat.count()).toBe(0);
    expect(await db.message.count()).toBe(0);
    expect(await db.webhookDelivery.count()).toBe(0);
  });

  it('round-trips json columns', async () => {
    const db = createTestDb();
    const instance = await seedInstance(db);

    await db.webhookConfig.create({
      data: {
        instanceId: instance.id,
        url: 'https://consumer.example/hook',
        headers: { 'X-Customer': 'acme' },
        events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
      },
    });

    const stored = await db.webhookConfig.findUnique({ where: { instanceId: instance.id } });

    expect(stored?.headers).toEqual({ 'X-Customer': 'acme' });
    expect(stored?.events).toEqual(['MESSAGES_UPSERT', 'CONNECTION_UPDATE']);
    expect(stored?.webhookByEvents).toBe(false);
  });
});
