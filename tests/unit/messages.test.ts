import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getContentType, getDevice, jidNormalizedUser } from 'baileys';
import type { WAMessage } from 'baileys';
import { describe, expect, it, vi } from 'vitest';
import { MEDIA_DIR, toEditedMessage, toInboundMessage, type InboundMessage, type Instance } from '../../src/instances';
import { createMessageService, mediaExtension } from '../../src/messages';
import { createOutbox } from '../../src/outbox';
import { createDatabaseQueue } from '../../src/queue';
import { createWebhookService } from '../../src/webhooks';
import envelope from '../fixtures/evolution/envelope.messages-upsert.json';
import raw from '../fixtures/evolution/messages-upsert.baileys.json';
import editedRaw from '../fixtures/evolution/messages-edited.baileys.json';
import editedEnvelope from '../fixtures/evolution/envelope.messages-edited.json';
import { createTestDb, silentLogger } from '../helpers';

const helpers = { getContentType, getDevice, jidNormalizedUser };

let instanceNumber = 0;

async function setup(events = ['MESSAGES_UPSERT']) {
  const db = createTestDb();
  const name = `acme-${++instanceNumber}`;
  const record = await db.instanceRecord.create({ data: { name } });
  await createWebhookService({ db }).setWebhook(name, {
    webhook: { enabled: true, url: 'https://consumer.example/webhooks/whatsapp', events },
  });

  const logger = silentLogger();
  const queue = createDatabaseQueue({ db, logger });
  const outbox = createOutbox({ db, queue, logger, serverUrl: 'http://localhost:3000' });
  const instance: Instance = {
    id: record.id,
    name,
    status: 'open',
    user: '5511999999999@s.whatsapp.net',
  };

  return { db, instance, service: createMessageService({ db, outbox, logger }) };
}

const NORMALIZE_INSTANCE_ID = 'instance-1';

function normalize(overrides: Record<string, unknown> = {}): InboundMessage {
  const message = toInboundMessage({ ...raw, ...overrides } as unknown as WAMessage, helpers, NORMALIZE_INSTANCE_ID);
  if (!message) throw new Error('fixture did not normalize');
  return message;
}

describe('toInboundMessage', () => {
  it('normalizes a Baileys message into the reference payload fields', () => {
    expect(normalize()).toEqual({
      key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: false, id: envelope.data.key.id },
      pushName: 'Jane',
      // Extended text is collapsed into a plain conversation, as the reference does.
      message: { conversation: 'hello there' },
      messageType: 'conversation',
      messageTimestamp: 1756555200,
      instanceId: NORMALIZE_INSTANCE_ID,
      source: 'android',
      status: 'DELIVERY_ACK',
    });
  });

  it('strips the device suffix from the participant of a group message', () => {
    const message = normalize({
      key: { ...raw.key, remoteJid: '123@g.us', participant: '5511888888888:12@s.whatsapp.net' },
    });
    expect(message.key).toMatchObject({
      remoteJid: '123@g.us',
      // The suffix sits in the user part, so the server must survive the strip.
      participant: '5511888888888@s.whatsapp.net',
    });
  });

  // A LID is an opaque id: its digits are not a phone number, and a consumer that reads
  // them as one shows the wrong contact entirely.
  it('prefers the phone number over the LID WhatsApp addressed the chat by', () => {
    const message = normalize({
      key: {
        ...raw.key,
        remoteJid: '100000000000001@lid',
        remoteJidAlt: '5511999990002@s.whatsapp.net',
      },
    });
    expect(message.key).toMatchObject({
      remoteJid: '5511999990002@s.whatsapp.net',
      // The LID is kept, because it is what the socket actually addresses.
      remoteJidAlt: '100000000000001@lid',
      // The reference reports the resolved form, overriding whatever Baileys said.
      addressingMode: 'pn',
    });
  });

  it('passes the addressing mode through when no swap was needed', () => {
    expect(normalize({ key: { ...raw.key, addressingMode: 'pn' } }).key.addressingMode).toBe('pn');
    // A LID with no phone number to swap to is still LID-addressed.
    expect(
      normalize({ key: { ...raw.key, remoteJid: '100000000000001@lid', addressingMode: 'lid' } }).key
        .addressingMode,
    ).toBe('lid');
  });

  it('omits the addressing mode when WhatsApp did not send one', () => {
    expect(normalize().key.addressingMode).toBeUndefined();
  });

  it('prefers the phone number of a group participant addressed by LID', () => {
    const message = normalize({
      key: {
        ...raw.key,
        remoteJid: '123@g.us',
        participant: '100000000000001@lid',
        participantAlt: '5511999990002:12@s.whatsapp.net',
      },
    });
    expect(message.key).toMatchObject({
      remoteJid: '123@g.us',
      participant: '5511999990002@s.whatsapp.net',
      participantAlt: '100000000000001@lid',
    });
  });

  it('keeps the LID when WhatsApp sends no phone number for it', () => {
    const message = normalize({ key: { ...raw.key, remoteJid: '100000000000001@lid' } });
    expect(message.key.remoteJid).toBe('100000000000001@lid');
    expect(message.key.remoteJidAlt).toBeUndefined();
  });

  it('leaves a phone-number chat alone and keeps its LID alongside', () => {
    const message = normalize({
      key: { ...raw.key, remoteJidAlt: '100000000000001@lid' },
    });
    expect(message.key).toMatchObject({
      remoteJid: '5511888888888@s.whatsapp.net',
      remoteJidAlt: '100000000000001@lid',
    });
  });

  it('falls back to the raw jid when it cannot be decoded', () => {
    expect(normalize({ key: { ...raw.key, remoteJid: 'nonsense' } }).key.remoteJid).toBe('nonsense');
  });

  // A click-to-WhatsApp ad referral rides in extendedTextMessage.contextInfo. Collapsing
  // the text to a conversation must not take the ad with it.
  it('keeps the ad referral when collapsing extended text', () => {
    const contextInfo = {
      externalAdReply: { sourceId: '120210000000000', title: 'Book Club', sourceType: 'ad' },
      conversionSource: 'FB_Ads',
      entryPointConversionApp: 'instagram',
    };
    const message = normalize({
      message: { extendedTextMessage: { text: '¡Hola! Quiero más información.', contextInfo } },
    });

    expect(message.messageType).toBe('conversation');
    // Metadata sits beside the content, never mixed into it.
    expect(message.message).toEqual({ conversation: '¡Hola! Quiero más información.' });
    expect(message.contextInfo).toEqual(contextInfo);
  });

  // An ad with an image or video creative puts the referral on the media node instead.
  it('surfaces the ad referral of a media message too', () => {
    const contextInfo = { externalAdReply: { sourceId: '120210000000000', title: 'Book Club' } };
    const message = normalize({
      message: { imageMessage: { mimetype: 'image/jpeg', caption: 'Quiero info', contextInfo } },
    });

    expect(message.messageType).toBe('imageMessage');
    expect(message.contextInfo).toEqual(contextInfo);
    // Media is not collapsed, so `message` still mirrors what Baileys sent.
    expect(message.message).toEqual({
      imageMessage: { mimetype: 'image/jpeg', caption: 'Quiero info', contextInfo },
    });
  });

  // Baileys decodes into protobuf class instances. The database rejects those outright,
  // which silently dropped every message carrying one.
  it('flattens protobuf instances into plain JSON', () => {
    class ContextInfo {
      constructor(readonly externalAdReply: { sourceId: string }) {}
    }
    const message = normalize({
      message: { extendedTextMessage: { text: 'Quiero info', contextInfo: new ContextInfo({ sourceId: '12' }) } },
    });

    expect(message.contextInfo).toEqual({ externalAdReply: { sourceId: '12' } });
    expect(Object.getPrototypeOf(message.contextInfo)).toBe(Object.prototype);
  });

  // Bytes otherwise serialize as 32 numbers, bloating every row and webhook body.
  it('encodes byte fields as base64', () => {
    const bytes = Uint8Array.from([160, 243, 62, 8]);
    const message = normalize({
      message: {
        extendedTextMessage: {
          text: 'hola',
          contextInfo: { ctwaPayload: bytes, messageSecret: Buffer.from(bytes) },
        },
      },
    });

    expect(message.contextInfo).toEqual({ ctwaPayload: 'oPM+CA==', messageSecret: 'oPM+CA==' });
  });

  it('falls back to the top-level message context', () => {
    const messageContextInfo = { deviceListMetadataVersion: 2 };
    expect(normalize({ message: { conversation: 'hi', messageContextInfo } }).contextInfo).toEqual(
      messageContextInfo,
    );
  });

  it('adds no context key when the message carries none', () => {
    expect(normalize().contextInfo).toBeUndefined();
    expect(normalize().message).toEqual({ conversation: 'hello there' });
  });

  it('reads a Long timestamp', () => {
    expect(normalize({ messageTimestamp: { toNumber: () => 1756555200 } }).messageTimestamp).toBe(1756555200);
  });

  it('assumes delivery for an incoming message with no receipt', () => {
    expect(normalize({ status: undefined }).status).toBe('DELIVERY_ACK');
  });

  // A protocol event is not something anyone sent. Delivering it as MESSAGES_UPSERT put
  // an empty message in the consumer's inbox on every revoke, edit, or timer change.
  it.each([
    ['a revoke or timer change', { protocolMessage: { type: 'REVOKE' } }],
    ['an edit', { editedMessage: { message: { protocolMessage: { type: 'MESSAGE_EDIT' } } } }],
  ])('drops %s', (_label, message) => {
    expect(toInboundMessage({ ...raw, message } as unknown as WAMessage, helpers, NORMALIZE_INSTANCE_ID)).toBeUndefined();
  });

  it('extracts an edit in the reference protocol payload shape', () => {
    expect(toEditedMessage(editedRaw as unknown as WAMessage, helpers)).toEqual({
      key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: false, id: envelope.data.key.id },
      data: editedEnvelope.data,
      message: { conversation: 'hello corrected' },
      messageType: 'conversation',
      messageTimestamp: 1756555300,
    });
  });

  it.each([
    ['no content', { message: undefined }],
    ['no key id', { key: { ...raw.key, id: undefined } }],
    ['no remote jid', { key: { ...raw.key, remoteJid: undefined } }],
    ['no key at all', { key: undefined }],
  ])('drops a malformed update with %s', (_label, overrides) => {
    expect(toInboundMessage({ ...raw, ...overrides } as unknown as WAMessage, helpers, NORMALIZE_INSTANCE_ID)).toBeUndefined();
  });
});

describe('message ingestion', () => {
  it('stores the message and queues the reference MESSAGES_UPSERT payload', async () => {
    const { db, instance, service } = await setup();

    await service.ingest(instance, [normalize()]);

    const [row] = await db.message.findMany();
    expect(row).toMatchObject({
      instanceId: instance.id,
      keyId: envelope.data.key.id,
      remoteJid: '5511888888888@s.whatsapp.net',
      fromMe: false,
      pushName: 'Jane',
      messageType: 'conversation',
      messageTimestamp: 1756555200,
      status: 'DELIVERY_ACK',
    });
    // The raw content is kept verbatim so a delivery can be replayed from the row.
    expect(row.content).toEqual({ conversation: 'hello there' });

    const [delivery] = await db.webhookDelivery.findMany();
    expect(delivery).toMatchObject({ event: 'MESSAGES_UPSERT', status: 'pending' });
    expect((delivery.payload as { data: unknown }).data).toEqual({
      ...envelope.data,
      instanceId: instance.id,
    });
  });

  it('persists and delivers the ad referral a lead arrived from', async () => {
    const { db, instance, service } = await setup();
    const contextInfo = { externalAdReply: { sourceId: '120210000000000', title: 'Book Club' } };

    await service.ingest(instance, [
      normalize({ message: { extendedTextMessage: { text: 'Quiero info', contextInfo } } }),
    ]);

    const [row] = await db.message.findMany();
    expect(row.contextInfo).toEqual(contextInfo);

    const [delivery] = await db.webhookDelivery.findMany();
    expect((delivery.payload as { data: { contextInfo: unknown } }).data.contextInfo).toEqual(contextInfo);
  });

  // Treating every write failure as a duplicate lost messages in silence.
  it('reports a write failure that is not a duplicate', async () => {
    const db = createTestDb();
    const logger = silentLogger();
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const queue = createDatabaseQueue({ db, logger });
    const outbox = createOutbox({ db, queue, logger });
    const service = createMessageService({ db, outbox, logger });
    // No instance row, so the foreign key rejects the write.
    const instance: Instance = { id: 'missing', name: 'ghost', status: 'open' };

    await service.ingest(instance, [normalize()]);

    expect(error).toHaveBeenCalledWith(expect.anything(), 'failed to store message');
    expect(await db.message.count()).toBe(0);
    expect(await db.webhookDelivery.count()).toBe(0);
  });

  it('ingests a batch as one row and one delivery per message', async () => {
    const { db, instance, service } = await setup();

    await service.ingest(instance, [
      normalize(),
      normalize({ key: { ...raw.key, id: 'BAE5AAAABBBBCCCCDDDDEEEEFFFF0001' }, messageTimestamp: 1756555260 }),
    ]);

    expect(await db.message.count()).toBe(2);
    expect(await db.webhookDelivery.count()).toBe(2);
  });

  it('ingests a replayed message once, so a restart redelivers nothing', async () => {
    const { db, instance, service } = await setup();

    await service.ingest(instance, [normalize()]);
    // A reconnect replays the same upsert; the message key is the idempotency key.
    await service.ingest(instance, [normalize()]);

    expect(await db.message.count()).toBe(1);
    expect(await db.webhookDelivery.count()).toBe(1);
  });

  it('stores a message even when no webhook selects the event', async () => {
    const { db, instance, service } = await setup(['CONNECTION_UPDATE']);

    await service.ingest(instance, [normalize()]);

    expect(await db.message.count()).toBe(1);
    expect(await db.webhookDelivery.count()).toBe(0);
  });

  it('persists an edit then queues the reference MESSAGES_EDITED payload', async () => {
    const { db, instance, service } = await setup(['MESSAGES_EDITED']);
    await service.ingest(instance, [normalize()]);
    const edited = toEditedMessage(editedRaw as unknown as WAMessage, helpers);
    if (!edited) throw new Error('fixture did not normalize');

    await service.handle({ type: 'message-edited', instance, message: edited });

    const [row] = await db.message.findMany();
    expect(row).toMatchObject({
      status: 'EDITED',
      messageType: 'conversation',
      messageTimestamp: 1756555300,
      content: { conversation: 'hello corrected' },
    });
    const [chat] = await db.chat.findMany();
    expect(chat.lastMessagePreview).toBe('hello corrected');
    const deliveries = await db.webhookDelivery.findMany({ orderBy: { event: 'asc' } });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].payload).toMatchObject({ event: 'messages.edited', data: editedEnvelope.data });
  });

  it('does not resurrect a revoked message when a late edit arrives', async () => {
    const { db, instance, service } = await setup(['MESSAGES_EDITED', 'MESSAGES_DELETE']);
    await service.ingest(instance, [normalize()]);
    await service.handle({ type: 'message-deleted', instance, key: normalize().key });
    const edited = toEditedMessage(editedRaw as unknown as WAMessage, helpers);
    if (!edited) throw new Error('fixture did not normalize');

    await service.handle({ type: 'message-edited', instance, message: edited });

    const [row] = await db.message.findMany();
    expect(row.status).toBe('DELETED');
    expect(row.content).toEqual({ conversation: 'hello there' });
    const deliveries = await db.webhookDelivery.findMany({ orderBy: { event: 'asc' } });
    expect(deliveries.map((delivery) => delivery.event)).toEqual(['MESSAGES_DELETE', 'MESSAGES_EDITED']);
  });

  it('persists a receipt before queuing MESSAGES_UPDATE', async () => {
    const { db, instance, service } = await setup(['MESSAGES_UPDATE']);
    const message = normalize();
    await service.ingest(instance, [message]);

    await service.handle({ type: 'message-updated', instance, update: { key: message.key, status: 'READ' } });

    const [row] = await db.message.findMany();
    expect(row.status).toBe('READ');
    const [delivery] = await db.webhookDelivery.findMany();
    expect(delivery).toMatchObject({ event: 'MESSAGES_UPDATE' });
    expect((delivery.payload as { data: unknown }).data).toEqual({
      keyId: message.key.id,
      remoteJid: message.key.remoteJid,
      fromMe: message.key.fromMe,
      status: 'READ',
      instanceId: instance.id,
    });
  });

  it('serializes a receipt with its upsert', async () => {
    const { db, instance, service } = await setup(['MESSAGES_UPDATE']);
    const message = normalize();

    await Promise.all([
      service.handle({ type: 'messages', instance, messages: [message] }),
      service.handle({ type: 'message-updated', instance, update: { key: message.key, status: 'READ' } }),
    ]);

    const [row] = await db.message.findMany();
    expect(row.status).toBe('READ');
  });

  it('stores a sent message before its receipt arrives', async () => {
    const { db, instance, service } = await setup(['MESSAGES_UPDATE']);
    const message = normalize({ key: { ...raw.key, fromMe: true }, status: 1 });

    await Promise.all([
      service.handle({ type: 'sent', instance, message }),
      service.handle({ type: 'message-updated', instance, update: { key: message.key, status: 'DELIVERY_ACK' } }),
    ]);

    const [row] = await db.message.findMany();
    expect(row).toMatchObject({ fromMe: true, status: 'DELIVERY_ACK' });
  });

  it('advances a stored message when its echo carries a newer receipt', async () => {
    const { db, instance, service } = await setup(['MESSAGES_UPDATE']);
    await service.handle({ type: 'sent', instance, message: normalize({ key: { ...raw.key, fromMe: true }, status: 1 }) });

    await service.handle({
      type: 'messages',
      instance,
      messages: [normalize({ key: { ...raw.key, fromMe: true }, status: 2 })],
    });

    const [row] = await db.message.findMany();
    expect(row.status).toBe('SERVER_ACK');
  });

  it('lets live messages run before the remaining history batches', async () => {
    const { db, instance, service } = await setup();
    const message = normalize();
    const messages = Array.from({ length: 501 }, (_, index) => ({
      ...message, key: { ...message.key, id: `HISTORY-${index}` },
    }));
    const history = service.handle({ type: 'history', instance, messages, contacts: [] });
    await vi.waitFor(async () => {
      expect(await db.message.count({ where: { keyId: 'HISTORY-0' } })).toBe(1);
    });
    await service.handle({ type: 'messages', instance, messages: [{
      ...message, key: { ...message.key, id: 'LIVE' },
    }] });
    expect(await db.message.count({ where: { keyId: 'HISTORY-500' } })).toBe(0);
    await history;
    expect(await db.message.count()).toBe(502);
    expect(await db.webhookDelivery.count()).toBe(1);
  }, 20000);

  it('uses persisted LID mappings for history messages and names without alternate addresses', async () => {
    const { db, instance, service } = await setup();
    const lid = '100000000000002@lid';
    const pn = '5511888888888@s.whatsapp.net';
    await db.baileysAuthState.create({ data: { instanceId: instance.id, creds: {}, keys: {
      'lid-mapping': { '5511888888888': '100000000000002', '100000000000002_reverse': '5511888888888' },
    } } });
    const message = normalize({ key: { ...raw.key, id: 'MAPPED-HISTORY', remoteJid: lid } });
    const unknown = normalize({ key: { ...raw.key, id: 'UNKNOWN-HISTORY', remoteJid: '999@lid' }, pushName: undefined });
    await service.handle({ type: 'history', instance, contacts: [{ id: lid, name: 'Address book name' }], messages: [message, unknown] });
    // A later phone-addressed echo is the same message, not a second row or chat.
    await service.handle({ type: 'history', instance, contacts: [], messages: [{ ...message, key: { ...message.key, remoteJid: pn } }] });
    expect(await db.message.count()).toBe(2);
    expect(await db.chat.count()).toBe(2);
    expect(await db.chat.findFirst({ where: { remoteJid: pn } })).toMatchObject({ name: 'Address book name' });
    expect(await db.message.findFirst({ where: { keyId: 'MAPPED-HISTORY' } })).toMatchObject({ remoteJid: pn });
    expect(await db.chat.count({ where: { remoteJid: lid } })).toBe(0);
    expect(await db.chat.count({ where: { remoteJid: '999@lid' } })).toBe(1);
    expect(await db.webhookDelivery.count()).toBe(0);
  });

  it('merges an earlier unresolved history chat when a mapping arrives later', async () => {
    const { db, instance, service } = await setup();
    const lid = '100000000000002@lid';
    const pn = '5511888888888@s.whatsapp.net';
    const older = normalize({ key: { ...raw.key, id: 'LATE-OLD', remoteJid: pn }, messageTimestamp: 1756555000 });
    const newer = normalize({ key: { ...raw.key, id: 'LATE-NEW', remoteJid: lid }, messageTimestamp: 1756555100 });
    await service.handle({ type: 'history', instance, contacts: [{ id: pn, name: 'Phone contact' }], messages: [older, newer] });
    expect(await db.chat.count()).toBe(2);
    await service.handle({ type: 'chat-alias', instance, alias: { lid, pn } });
    await service.handle({ type: 'chat-alias', instance, alias: { lid, pn } });
    expect(await db.chat.count()).toBe(1);
    expect(await db.message.count({ where: { remoteJid: pn } })).toBe(2);
    expect(await db.chat.findFirst()).toMatchObject({ remoteJid: pn, name: 'Phone contact', lastMessageAt: new Date(1756555100 * 1000) });
    expect(await db.webhookDelivery.count()).toBe(0);
  });

  it('ingests history without publishing, names chats, and is idempotent', async () => {
    const { db, instance, service } = await setup();
    const older = normalize({ key: { ...raw.key, id: 'HISTORY-OLD' }, messageTimestamp: 1756555000 });
    const newer = normalize({ key: { ...raw.key, id: 'HISTORY-NEW' }, messageTimestamp: 1756555100 });
    const event = {
      type: 'history' as const,
      instance,
      messages: [newer, older],
      contacts: [{ id: newer.key.remoteJid, name: 'Jane Contact' }],
    };

    await service.handle(event);
    await service.handle(event);

    expect(await db.message.count()).toBe(2);
    expect(await db.webhookDelivery.count()).toBe(0);
    const [chat] = await db.chat.findMany();
    expect(chat).toMatchObject({ name: 'Jane Contact', lastMessageAt: new Date(1756555100 * 1000) });
  });

  // WhatsApp can address a chat by LID while the stored row predates the migration and
  // lives under the phone-number jid; the receipt must still find its row.
  it('applies a receipt keyed by another jid form to the stored row', async () => {
    const { db, instance, service } = await setup(['MESSAGES_UPDATE']);
    const message = normalize({ key: { ...raw.key, fromMe: true }, status: 1 });
    await service.handle({ type: 'sent', instance, message });

    await service.handle({
      type: 'message-updated',
      instance,
      update: { key: { ...message.key, remoteJid: '100000000000002@lid' }, status: 'DELIVERY_ACK' },
    });

    const [row] = await db.message.findMany();
    expect(row).toMatchObject({ keyId: message.key.id, status: 'DELIVERY_ACK' });
  });

  it('never steps a stored receipt backwards', async () => {
    const { db, instance, service } = await setup(['MESSAGES_UPDATE']);
    await service.handle({ type: 'sent', instance, message: normalize({ key: { ...raw.key, fromMe: true }, status: 1 }) });
    await service.handle({
      type: 'messages',
      instance,
      messages: [normalize({ key: { ...raw.key, fromMe: true }, status: 3 })],
    });
    // A late PENDING echo must not demote the delivery.
    await service.handle({
      type: 'messages',
      instance,
      messages: [normalize({ key: { ...raw.key, fromMe: true }, status: 1 })],
    });

    const [row] = await db.message.findMany();
    expect(row.status).toBe('DELIVERY_ACK');
  });

  it('does not resurrect a revoked message through its echo', async () => {
    const { db, instance, service } = await setup(['MESSAGES_UPDATE', 'MESSAGES_DELETE']);
    const sent = normalize({ key: { ...raw.key, fromMe: true }, status: 1 });
    await service.handle({ type: 'sent', instance, message: sent });
    await service.handle({ type: 'message-deleted', instance, key: sent.key });

    await service.handle({
      type: 'messages',
      instance,
      messages: [normalize({ key: { ...raw.key, fromMe: true }, status: 3 })],
    });

    const [row] = await db.message.findMany();
    expect(row.status).toBe('DELETED');
  });

  it('marks a revoked message deleted, hides its preview, and queues MESSAGES_DELETE', async () => {
    const { db, instance, service } = await setup(['MESSAGES_DELETE', 'MESSAGES_UPDATE']);
    const message = normalize();
    await service.ingest(instance, [message]);

    await service.handle({ type: 'message-deleted', instance, key: message.key });
    await service.handle({ type: 'message-updated', instance, update: { key: message.key, status: 'READ' } });

    const [row] = await db.message.findMany();
    expect(row.status).toBe('DELETED');
    const [chat] = await db.chat.findMany();
    expect(chat).toMatchObject({ lastMessageAt: null, lastMessagePreview: null });
    const deliveries = await db.webhookDelivery.findMany({ orderBy: { event: 'asc' } });
    expect(deliveries.map((delivery) => delivery.event)).toEqual(['MESSAGES_DELETE', 'MESSAGES_UPDATE']);
    expect((deliveries[0].payload as { data: unknown }).data).toEqual({ ...message.key, status: 'DELETED' });
  });

  it('projects the chat and keeps the newest message as the preview', async () => {
    const { db, instance, service } = await setup();

    await service.ingest(instance, [normalize()]);
    await service.ingest(instance, [
      normalize({ key: { ...raw.key, id: 'BAE5AAAABBBBCCCCDDDDEEEEFFFF0002' }, messageTimestamp: 1756555260,
        message: { conversation: 'newer' } }),
    ]);
    // Backfill of an older message must not overwrite the preview.
    await service.ingest(instance, [
      normalize({ key: { ...raw.key, id: 'BAE5AAAABBBBCCCCDDDDEEEEFFFF0003' }, messageTimestamp: 1756554000,
        message: { conversation: 'older' } }),
    ]);

    const [chat] = await db.chat.findMany();
    expect(chat).toMatchObject({
      instanceId: instance.id,
      remoteJid: '5511888888888@s.whatsapp.net',
      name: 'Jane',
      lastMessagePreview: 'newer',
    });
    expect(chat.lastMessageAt).toEqual(new Date(1756555260 * 1000));
  });

  it('uses the direct sender profile name as a chat fallback', async () => {
    const { db, instance, service } = await setup();

    await service.ingest(instance, [normalize({ pushName: undefined })]);
    await service.ingest(instance, [
      normalize({ key: { ...raw.key, id: 'PROFILE-NAME' }, pushName: 'Jane' }),
    ]);

    const [chat] = await db.chat.findMany();
    expect(chat.name).toBe('Jane');
  });

  it('never names a group chat after whoever spoke in it', async () => {
    const { db, instance, service } = await setup();

    await service.ingest(instance, [
      normalize({
        key: { ...raw.key, remoteJid: '5511999990003-1700000000@g.us', participant: '5511999990004@s.whatsapp.net' },
        pushName: 'Sam Rivera',
      }),
    ]);

    const [chat] = await db.chat.findMany();
    expect(chat).toMatchObject({ remoteJid: '5511999990003-1700000000@g.us', name: null });
  });

  // A story is not a chat message: a MESSAGES_UPSERT subscription must never receive it.
  it('stores status broadcasts without delivering them as MESSAGES_UPSERT', async () => {
    const { db, instance, service } = await setup();

    await service.ingest(instance, [normalize({ key: { ...raw.key, remoteJid: 'status@broadcast' } })]);

    expect(await db.chat.count()).toBe(0);
    expect(await db.message.count()).toBe(1);
    expect(await db.webhookDelivery.count()).toBe(0);
  });

  it('delivers a status broadcast only when STATUS_UPDATE is explicitly selected', async () => {
    const { db, instance, service } = await setup(['STATUS_UPDATE']);

    await service.ingest(instance, [normalize({ key: { ...raw.key, remoteJid: 'status@broadcast' } })]);

    const [delivery] = await db.webhookDelivery.findMany();
    expect(delivery).toMatchObject({ event: 'STATUS_UPDATE', status: 'pending' });
    expect(delivery.payload).toMatchObject({
      event: 'status.update',
      data: { key: { remoteJid: 'status@broadcast' }, instanceId: instance.id },
    });
  });

  it('previews a non-text message by its type', async () => {
    const { db, instance, service } = await setup();

    await service.ingest(instance, [normalize({ message: { imageMessage: { mimetype: 'image/jpeg' } } })]);

    const [chat] = await db.chat.findMany();
    expect(chat.lastMessagePreview).toBe('[imageMessage]');
  });

  describe('contact names', () => {
    const remoteJid = '5511888888888@s.whatsapp.net';

    it('names an existing direct chat from contacts.upsert data', async () => {
      const { db, instance, service } = await setup();
      await service.ingest(instance, [normalize({ key: { ...raw.key, remoteJid } })]);

      await service.nameContacts(instance, [{ id: remoteJid, name: 'Jane Contact' }]);

      const [chat] = await db.chat.findMany();
      expect(chat).toMatchObject({ remoteJid, name: 'Jane Contact' });
    });

    it('does not create a chat for a contact without messages', async () => {
      const { db, instance, service } = await setup();

      await service.nameContacts(instance, [{ id: remoteJid, name: 'Jane Contact' }]);

      expect(await db.chat.count()).toBe(0);
    });

    it('applies a contact name that arrived before its first message', async () => {
      const { db, instance, service } = await setup();
      await service.nameContacts(instance, [{ id: remoteJid, name: 'Jane Contact' }]);

      await service.ingest(instance, [normalize({ key: { ...raw.key, remoteJid } })]);

      const [chat] = await db.chat.findMany();
      expect(chat).toMatchObject({ remoteJid, name: 'Jane Contact' });
    });

    it('handles a contact event through the subscription', async () => {
      const { db, instance, service } = await setup();
      await service.ingest(instance, [normalize({ key: { ...raw.key, remoteJid } })]);

      await service.handle({ type: 'contacts', instance, contacts: [{ id: remoteJid, name: 'Jane Contact' }] });

      const [chat] = await db.chat.findMany();
      expect(chat.name).toBe('Jane Contact');
    });
  });

  describe('group names', () => {
    const remoteJid = '5511999990003-1700000000@g.us';

    it('names a group chat, which no message can do', async () => {
      const { db, instance, service } = await setup();
      await service.ingest(instance, [normalize({ key: { ...raw.key, remoteJid } })]);

      await service.nameGroups(instance, [{ id: remoteJid, subject: 'Book Club' }]);

      const [chat] = await db.chat.findMany();
      expect(chat).toMatchObject({ remoteJid, name: 'Book Club' });
    });

    it('creates no chat for a group nobody has written in', async () => {
      const { db, instance, service } = await setup();

      await service.nameGroups(instance, [{ id: remoteJid, subject: 'Book Club' }]);

      expect(await db.chat.count()).toBe(0);
    });

    it('applies a group subject that arrived before its first message', async () => {
      const { db, instance, service } = await setup();
      await service.nameGroups(instance, [{ id: remoteJid, subject: 'Book Club' }]);

      await service.ingest(instance, [normalize({ key: { ...raw.key, remoteJid } })]);

      const [chat] = await db.chat.findMany();
      expect(chat).toMatchObject({ remoteJid, name: 'Book Club' });
    });

    it('never renames another instance a chat', async () => {
      const { db, instance, service } = await setup();
      await service.ingest(instance, [normalize({ key: { ...raw.key, remoteJid } })]);

      await service.nameGroups({ ...instance, id: 'someone-else' }, [
        { id: remoteJid, subject: 'Book Club' },
      ]);

      const [chat] = await db.chat.findMany();
      expect(chat.name).toBeNull();
    });

    it('handles a group event through the subscription', async () => {
      const { db, instance, service } = await setup();
      await service.ingest(instance, [normalize({ key: { ...raw.key, remoteJid } })]);

      await service.handle({ type: 'groups', instance, groups: [{ id: remoteJid, subject: 'Quinta' }] });

      const [chat] = await db.chat.findMany();
      expect(chat.name).toBe('Quinta');
    });
  });

  it('ignores instance events that are not messages', async () => {
    const { db, instance, service } = await setup();

    await service.handle({ type: 'updated', instance, change: 'connection' });

    expect(await db.message.count()).toBe(0);
  });
});

describe('media persistence', () => {
  function imageMessage(keyId: string): InboundMessage {
    const base = normalize();
    return {
      ...base,
      key: { ...base.key, id: keyId },
      messageType: 'imageMessage',
      message: { imageMessage: { mimetype: 'image/jpeg', mediaKey: 'never-shown' } },
      media: { buffer: Buffer.from('pixels'), mimetype: 'image/jpeg' },
    };
  }

  it('writes the downloaded bytes to the media dir and maps them onto the message', async () => {
    const { db, instance, service } = await setup([]);

    await service.ingest(instance, [imageMessage('MEDIA-1')]);

    const media = await db.media.findFirst({ where: { message: { keyId: 'MEDIA-1' } } });
    expect(media).toMatchObject({ path: 'MEDIA-1.jpg', mimetype: 'image/jpeg', size: 6 });
    expect(readFileSync(join(MEDIA_DIR, instance.name, media!.path), 'utf8')).toBe('pixels');
  });

  it('persists the message alone when nothing was downloaded', async () => {
    const { db, instance, service } = await setup([]);

    await service.ingest(instance, [normalize()]);

    expect(await db.message.count()).toBe(1);
    expect(await db.media.count()).toBe(0);
  });

  it('does not re-download a replayed message', async () => {
    const { db, instance, service } = await setup([]);

    await service.ingest(instance, [imageMessage('MEDIA-2')]);
    await service.ingest(instance, [imageMessage('MEDIA-2')]);

    expect(await db.media.count()).toBe(1);
  });
});

describe('mediaExtension', () => {
  it('maps known mimetypes and defaults unknowns', () => {
    expect(mediaExtension('image/jpeg')).toBe('.jpg');
    expect(mediaExtension('video/mp4')).toBe('.mp4');
    expect(mediaExtension('audio/ogg; codecs=opus')).toBe('.ogg');
    expect(mediaExtension('application/whatever')).toBe('.bin');
    expect(mediaExtension('constructor')).toBe('.bin');
  });
});
