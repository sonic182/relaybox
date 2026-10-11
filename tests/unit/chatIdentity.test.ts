import { describe, expect, it } from 'vitest';
import { repairChatAliases } from '../../src/chatIdentity';
import { createTestDb } from '../helpers';

const lid = '100000000000002@lid';
const pn = '5511888888888@s.whatsapp.net';

async function setup() {
  const db = createTestDb();
  const instance = await db.instanceRecord.create({ data: { name: 'identity-repair' } });
  await db.baileysAuthState.create({ data: { instanceId: instance.id, creds: {}, keys: {
    'lid-mapping': {
      '5511888888888': '100000000000002', '100000000000002_reverse': '5511888888888',
      // A stale reverse mapping must not merge a different identity.
      '999_reverse': '5511888888888',
    },
  } } });
  await db.chat.create({ data: { instanceId: instance.id, remoteJid: pn, name: 'Phone contact', lastMessageAt: new Date(100000), lastMessagePreview: 'older' } });
  await db.chat.create({ data: { instanceId: instance.id, remoteJid: lid, lastMessageAt: new Date(200000), lastMessagePreview: 'newer' } });
  const message = (remoteJid: string, keyId: string, text = 'same', status = 'DELIVERY_ACK') => db.message.create({ data: {
    instanceId: instance.id, remoteJid, keyId, fromMe: false, messageType: 'conversation',
    messageTimestamp: 200, content: { conversation: text }, status,
  } });
  return { db, instance, message };
}

describe('chat identity repair', () => {
  it('previews without writes, preserves media and receipts on merge, and is repeatable', async () => {
    const { db, instance, message } = await setup();
    const duplicate = await message(pn, 'DUPLICATE');
    const source = await message(lid, 'DUPLICATE', 'same', 'READ');
    await message(lid, 'UNIQUE');
    const media = await db.media.create({ data: { messageId: source.id, path: 'DUPLICATE.jpg', mimetype: 'image/jpeg' } });
    await db.chat.create({ data: { instanceId: instance.id, remoteJid: '999@lid' } });
    const preview = await repairChatAliases(db, instance.id);
    expect(preview).toEqual(expect.arrayContaining([
      expect.objectContaining({ lid, pn, messages: 2, duplicates: 1, action: 'merge' }),
      expect.objectContaining({ lid: '999@lid', action: 'unresolved' }),
    ]));
    expect(await db.message.count()).toBe(3);
    expect(await db.chat.count()).toBe(3);
    expect(await db.media.findFirst()).toMatchObject({ messageId: source.id });

    await repairChatAliases(db, instance.id, true);
    expect(await db.message.count()).toBe(2);
    expect(await db.message.count({ where: { remoteJid: pn } })).toBe(2);
    expect(await db.chat.count({ where: { remoteJid: lid } })).toBe(0);
    expect(await db.chat.findFirst({ where: { remoteJid: pn } })).toMatchObject({ name: 'Phone contact', lastMessageAt: new Date(200000), lastMessagePreview: 'newer' });
    expect(await db.media.findUnique({ where: { id: media.id } })).toMatchObject({ messageId: duplicate.id });
    expect(await db.message.findUnique({ where: { id: duplicate.id } })).toMatchObject({ status: 'READ' });
    expect(await repairChatAliases(db, instance.id, true)).toEqual([
      expect.objectContaining({ lid: '999@lid', action: 'unresolved' }),
    ]);
    expect(await db.chat.count()).toBe(2);
    expect(await db.webhookDelivery.count()).toBe(0);
  });

  it('leaves conflicting duplicate content untouched rather than losing an edit', async () => {
    const { db, instance, message } = await setup();
    await message(pn, 'CONFLICT', 'edited');
    await message(lid, 'CONFLICT', 'original');
    const result = await repairChatAliases(db, instance.id, true);
    expect(result).toEqual([expect.objectContaining({ action: 'blocked', duplicates: 1 })]);
    expect(await db.chat.count()).toBe(2);
    expect(await db.message.count()).toBe(2);
    expect(await db.message.findFirst({ where: { remoteJid: lid } })).toMatchObject({ content: { conversation: 'original' } });
  });
});
