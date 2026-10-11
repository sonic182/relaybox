import type { JsonObject } from '@zenstackhq/orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createChatService } from '../../src/chats';
import { createTestDbWithInstance } from '../helpers';

let instanceNumber = 0;

async function setup() {
  const { db, instance } = await createTestDbWithInstance(`acme-${++instanceNumber}`);
  return { db, instance, service: createChatService({ db }) };
}

type MessageInput = {
  instanceId: string;
  remoteJid?: string;
  keyId: string;
  at: number;
  fromMe?: boolean;
  content?: Record<string, unknown>;
};

function message({ instanceId, remoteJid = 'alex@s.whatsapp.net', keyId, at, fromMe = false, content }: MessageInput) {
  return {
    instanceId,
    remoteJid,
    keyId,
    fromMe,
    messageType: content && !content.conversation ? 'imageMessage' : 'conversation',
    messageTimestamp: at,
    content: (content ?? { conversation: keyId }) as JsonObject,
  };
}

describe('chat list', () => {
  it('shows the newest conversation first', async () => {
    const { db, instance, service } = await setup();
    await db.chat.create({
      data: {
        instanceId: instance.id,
        remoteJid: 'alex@s.whatsapp.net',
        name: 'Alex',
        lastMessageAt: new Date('2026-08-30T10:00:00Z'),
        lastMessagePreview: 'older',
      },
    });
    await db.chat.create({
      data: {
        instanceId: instance.id,
        remoteJid: 'rosa@g.us',
        lastMessageAt: new Date('2026-08-30T12:00:00Z'),
        lastMessagePreview: 'newer',
      },
    });

    const chats = await service.listChats(instance.name);

    expect(chats.chats.map((chat) => chat.remoteJid)).toEqual(['rosa@g.us', 'alex@s.whatsapp.net']);
    expect(chats.chats[1]).toMatchObject({ name: 'Alex', lastMessagePreview: 'older' });
    expect(chats.cursor).toBeNull();
  });

  it('pages through equal timestamps and chats without activity without duplicates', async () => {
    const { db, instance, service } = await setup();
    const activeAt = new Date('2026-08-30T12:00:00Z');
    for (const [remoteJid, lastMessageAt] of [
      ['b@g.us', activeAt],
      ['a@g.us', activeAt],
      ['c@g.us', new Date('2026-08-29T12:00:00Z')],
      ['e@g.us', null],
      ['d@g.us', null],
    ] as const) {
      await db.chat.create({ data: { instanceId: instance.id, remoteJid, lastMessageAt } });
    }

    const first = await service.listChats(instance.name, { limit: 2 });
    const second = await service.listChats(instance.name, { limit: 2, before: first.cursor ?? undefined });
    const third = await service.listChats(instance.name, { limit: 2, before: second.cursor ?? undefined });

    expect([...first.chats, ...second.chats, ...third.chats].map((chat) => chat.remoteJid)).toEqual([
      'a@g.us', 'b@g.us', 'c@g.us', 'd@g.us', 'e@g.us',
    ]);
    expect(first.cursor).toBeTruthy();
    expect(second.cursor).toBeTruthy();
    expect(third.cursor).toBeNull();
  });

  it('searches chat names and JIDs with a case-insensitive partial match', async () => {
    const { db, instance, service } = await setup();
    await db.chat.create({ data: { instanceId: instance.id, remoteJid: '5511@s.whatsapp.net', name: 'Alice' } });
    await db.chat.create({ data: { instanceId: instance.id, remoteJid: 'rosa@g.us', name: 'Family' } });
    await db.chat.create({ data: { instanceId: instance.id, remoteJid: 'other@g.us', name: 'Other' } });

    const byName = await service.listChats(instance.name, { search: 'ALI' });
    const byJid = await service.listChats(instance.name, { search: 'ROSA' });

    expect(byName.chats.map((chat) => chat.remoteJid)).toEqual(['5511@s.whatsapp.net']);
    expect(byJid.chats.map((chat) => chat.remoteJid)).toEqual(['rosa@g.us']);
  });

  it('never shows another instance a chat', async () => {
    const { db, instance, service } = await setup();
    const other = await db.instanceRecord.create({ data: { name: `globex-${++instanceNumber}` } });
    await db.chat.create({ data: { instanceId: other.id, remoteJid: 'alex@s.whatsapp.net' } });

    expect(await service.listChats(instance.name)).toEqual({ chats: [], cursor: null });
  });

  it('answers with nothing for an unknown instance', async () => {
    const { service } = await setup();

    expect(await service.listChats('ghost')).toEqual({ chats: [], cursor: null });
  });
});

describe('message history', () => {
  async function conversation(count: number) {
    const { db, instance, service } = await setup();
    for (let index = 0; index < count; index++) {
      await db.message.create({
        data: message({ instanceId: instance.id, keyId: `m${index}`, at: 1756555200 + index }),
      });
    }
    return { db, instance, service };
  }

  it('reads oldest first, the order a conversation reads in', async () => {
    const { instance, service } = await conversation(3);

    const page = await service.listMessages(instance.name, 'alex@s.whatsapp.net');

    expect(page.messages.map((entry) => entry.text)).toEqual(['m0', 'm1', 'm2']);
    expect(page.cursor).toBeNull();
  });

  it('pages backwards through older messages', async () => {
    const { instance, service } = await conversation(5);

    const first = await service.listMessages(instance.name, 'alex@s.whatsapp.net', { limit: 2 });
    expect(first.messages.map((entry) => entry.text)).toEqual(['m3', 'm4']);
    expect(first.cursor).toBeTruthy();

    const second = await service.listMessages(instance.name, 'alex@s.whatsapp.net', {
      limit: 2,
      before: first.cursor ?? undefined,
    });
    expect(second.messages.map((entry) => entry.text)).toEqual(['m1', 'm2']);

    const last = await service.listMessages(instance.name, 'alex@s.whatsapp.net', {
      limit: 2,
      before: second.cursor ?? undefined,
    });
    expect(last.messages.map((entry) => entry.text)).toEqual(['m0']);
    // Nothing older, so the UI stops asking.
    expect(last.cursor).toBeNull();
  });

  // Several messages can share a second, so the cursor carries the row id too.
  it('does not skip or repeat messages sharing a timestamp', async () => {
    const { db, instance, service } = await setup();
    for (const keyId of ['a', 'b', 'c', 'd']) {
      await db.message.create({ data: message({ instanceId: instance.id, keyId, at: 1756555200 }) });
    }

    const first = await service.listMessages(instance.name, 'alex@s.whatsapp.net', { limit: 2 });
    const second = await service.listMessages(instance.name, 'alex@s.whatsapp.net', {
      limit: 2,
      before: first.cursor ?? undefined,
    });

    const seen = [...second.messages, ...first.messages].map((entry) => entry.text);
    expect(new Set(seen).size).toBe(4);
  });

  it('keeps chats and instances apart', async () => {
    const { db, instance, service } = await setup();
    await db.message.create({ data: message({ instanceId: instance.id, keyId: 'mine', at: 1756555200 }) });
    await db.message.create({
      data: message({ instanceId: instance.id, remoteJid: 'rosa@g.us', keyId: 'theirs', at: 1756555300 }),
    });

    const page = await service.listMessages(instance.name, 'alex@s.whatsapp.net');

    expect(page.messages.map((entry) => entry.text)).toEqual(['mine']);
  });

  // content holds the raw Baileys payload and must never leave the service.
  it('lifts out plain text only, never the stored payload', async () => {
    const { db, instance, service } = await setup();
    await db.message.create({
      data: message({
        instanceId: instance.id,
        keyId: 'media',
        at: 1756555200,
        content: { imageMessage: { mimetype: 'image/jpeg', mediaKey: 'super-secret' } },
      }),
    });

    const page = await service.listMessages(instance.name, 'alex@s.whatsapp.net');

    expect(page.messages[0]).toMatchObject({ messageType: 'imageMessage', text: null });
    expect(JSON.stringify(page)).not.toContain('super-secret');
  });

  it('answers with nothing for an unknown instance or an empty chat', async () => {
    const { instance, service } = await conversation(1);

    expect(await service.listMessages('ghost', 'alex@s.whatsapp.net')).toEqual({ messages: [], cursor: null });
    expect(await service.listMessages(instance.name, 'nobody@s.whatsapp.net')).toEqual({
      messages: [],
      cursor: null,
    });
  });

  it('ignores a malformed cursor rather than failing', async () => {
    const { instance, service } = await conversation(2);

    const page = await service.listMessages(instance.name, 'alex@s.whatsapp.net', { before: 'nonsense' });

    expect(page.messages).toHaveLength(2);
  });
});

describe('media', () => {
  async function imageMessage(keyId: string) {
    const { db, instance, service } = await setup();
    const created = await db.message.create({
      data: message({ instanceId: instance.id, keyId, at: 1756555200, content: { imageMessage: { mediaKey: 'k' } } }),
    });
    return { db, instance, service, created };
  }

  it('flags a message whose download is on disk', async () => {
    const { db, instance, service, created } = await imageMessage('IMG-1');
    await db.media.create({ data: { messageId: created.id, path: 'IMG-1.jpg', mimetype: 'image/jpeg' } });

    const page = await service.listMessages(instance.name, 'alex@s.whatsapp.net');

    expect(page.messages[0]).toMatchObject({ mediaType: 'image', text: null });
  });

  it('leaves a message without a stored file unflagged', async () => {
    const { instance, service } = await imageMessage('IMG-2');

    const page = await service.listMessages(instance.name, 'alex@s.whatsapp.net');

    expect(page.messages[0].mediaType).toBeUndefined();
  });

  it('never flags a deleted message', async () => {
    const { db, instance, service, created } = await imageMessage('IMG-3');
    await db.media.create({ data: { messageId: created.id, path: 'IMG-3.jpg', mimetype: 'image/jpeg' } });
    await db.message.update({ where: { id: created.id }, data: { status: 'DELETED' } });

    const page = await service.listMessages(instance.name, 'alex@s.whatsapp.net');

    expect(page.messages[0].mediaType).toBeUndefined();
  });

  it('downloads imported media on demand once and serves the cached bytes on retries', async () => {
    const { db, instance, created } = await imageMessage('HISTORY-MEDIA');
    const bytes = Buffer.from('downloaded-history-media');
    const downloadMedia = vi.fn(async () => ({ buffer: bytes, mimetype: 'image/png' }));
    const service = createChatService({ db, downloadMedia });
    const [first, concurrent] = await Promise.all([
      service.getMedia(instance.name, 'HISTORY-MEDIA'), service.getMedia(instance.name, 'HISTORY-MEDIA'),
    ]);
    expect(first).toMatchObject({ mimetype: 'image/png', messageType: 'imageMessage' });
    expect(concurrent).toEqual(first);
    expect(downloadMedia).toHaveBeenCalledOnce();
    expect(readFileSync(join(process.env.MEDIA_DIR!, instance.name, first!.path))).toEqual(bytes);
    expect(await db.media.findUnique({ where: { messageId: created.id } })).toMatchObject({ path: first!.path, size: bytes.length });
    expect(await service.getMedia(instance.name, 'HISTORY-MEDIA')).toEqual(first);
    expect(downloadMedia).toHaveBeenCalledOnce();
  });

  it('does not cache unavailable media or media revoked during a download', async () => {
    const { db, instance, created } = await imageMessage('UNAVAILABLE-MEDIA');
    const downloadMedia = vi.fn(async () => undefined as { buffer: Buffer; mimetype: string } | undefined);
    const service = createChatService({ db, downloadMedia });
    expect(await service.getMedia(instance.name, 'UNAVAILABLE-MEDIA')).toBeNull();
    expect(await db.media.count()).toBe(0);
    downloadMedia.mockImplementationOnce(async () => {
      await db.message.update({ where: { id: created.id }, data: { status: 'DELETED' } });
      return { buffer: Buffer.from('revoked'), mimetype: 'image/png' };
    });
    expect(await service.getMedia(instance.name, 'UNAVAILABLE-MEDIA')).toBeNull();
    expect(await db.media.count()).toBe(0);
    expect(await service.getMedia(instance.name, 'UNAVAILABLE-MEDIA')).toBeNull();
    expect(downloadMedia).toHaveBeenCalledTimes(2);
  });

  it('hands out the stored file for its own instance only', async () => {
    const { db, instance, service, created } = await imageMessage('IMG-4');
    await db.media.create({ data: { messageId: created.id, path: 'IMG-4.jpg', mimetype: 'image/jpeg' } });

    expect(await service.getMedia(instance.name, 'IMG-4')).toEqual({
      path: 'IMG-4.jpg',
      mimetype: 'image/jpeg',
      messageType: 'imageMessage',
    });
    expect(await service.getMedia(instance.name, 'ghost')).toBeNull();
    expect(await service.getMedia('ghost', 'IMG-4')).toBeNull();

    await db.message.update({ where: { id: created.id }, data: { status: 'DELETED' } });
    expect(await service.getMedia(instance.name, 'IMG-4')).toBeNull();
  });

  it('finds a non-deleted message for its own instance only', async () => {
    const { db, instance, service, created } = await imageMessage('IMG-5');
    await db.media.create({ data: { messageId: created.id, path: 'IMG-5.jpg', mimetype: 'image/jpeg' } });

    expect(await service.findMessage(instance.name, 'IMG-5')).toMatchObject({
      key: { id: 'IMG-5' },
      message: { imageMessage: {} },
      media: { path: 'IMG-5.jpg', mimetype: 'image/jpeg' },
    });
    expect(await service.findMessage(instance.name, 'ghost')).toBeNull();
    expect(await service.findMessage('ghost', 'IMG-5')).toBeNull();

    await db.message.update({ where: { id: created.id }, data: { status: 'DELETED' } });
    expect(await service.findMessage(instance.name, 'IMG-5')).toBeNull();
  });
});
