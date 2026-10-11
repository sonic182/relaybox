import { describe, expect, it } from 'vitest';
import { MAX_OUTBOUND_MEDIA_BYTES } from '../../src/config';
import { createOutbox } from '../../src/outbox';
import { createDatabaseQueue } from '../../src/queue';
import { createWebhookService } from '../../src/webhooks';
import { createTestDb, silentLogger } from '../helpers';
import updateEnvelope from '../fixtures/evolution/envelope.send-message-update.json';

let instanceNumber = 0;

async function setup(webhook: Record<string, unknown> | null = { enabled: true, url: 'https://consumer.example/hook', events: ['CONNECTION_UPDATE'] }) {
  const db = createTestDb();
  const name = `acme-${++instanceNumber}`;
  const instance = await db.instanceRecord.create({ data: { name } });
  if (webhook) await createWebhookService({ db }).setWebhook(name, { webhook });

  const queue = createDatabaseQueue({ db, logger: silentLogger() });
  const outbox = createOutbox({ db, queue, logger: silentLogger(), serverUrl: 'http://localhost:3000' });

  return { db, instance, queue, outbox };
}

function connectionUpdate(instanceId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'delivery-1',
    occurredAt: new Date('2026-08-30T12:00:00.000Z'),
    event: 'CONNECTION_UPDATE' as const,
    instanceId,
    instanceName: 'acme',
    data: { instance: 'acme', state: 'open' },
    sender: '5511999999999@s.whatsapp.net',
    dedupeKey: 'CONNECTION_UPDATE:acme:1',
    ...overrides,
  };
}

function mediaMessage(
  instanceId: string,
  event: 'MESSAGES_UPSERT' | 'SEND_MESSAGE' = 'MESSAGES_UPSERT',
  buffer = Buffer.from('sticker-bytes'),
) {
  return {
    id: `delivery-${event}`,
    occurredAt: new Date('2026-08-30T12:00:00.000Z'),
    event,
    instanceId,
    instanceName: 'acme',
    data: {
      key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: event === 'SEND_MESSAGE', id: 'STICKER-1' },
      message: { stickerMessage: { mimetype: 'image/webp' } },
      messageType: 'stickerMessage',
    },
    dedupeKey: `${event}:STICKER-1`,
    media: { buffer, mimetype: 'image/webp' },
  };
}

describe('outbox', () => {
  it('queues one job carrying the reference envelope', async () => {
    const { db, instance, outbox } = await setup();

    expect(await outbox.enqueue(connectionUpdate(instance.id))).toBe(true);

    const [row] = await db.webhookDelivery.findMany();
    expect(row).toMatchObject({
      id: 'delivery-1',
      event: 'CONNECTION_UPDATE',
      url: 'https://consumer.example/hook',
      status: 'pending',
      attempts: 0,
    });
    expect(row.payload).toEqual({
      event: 'connection.update',
      instance: 'acme',
      data: { instance: 'acme', state: 'open' },
      destination: 'https://consumer.example/hook',
      date_time: '2026-08-30T12:00:00.000Z',
      sender: '5511999999999@s.whatsapp.net',
      server_url: 'http://localhost:3000',
      // No per-instance token exists yet, and API_KEY is the dashboard credential.
      apikey: '',
    });
  });

  it('appends the kebab-case event suffix when byEvents is set', async () => {
    const { instance, outbox, db } = await setup({
      enabled: true,
      url: 'https://consumer.example/hook',
      byEvents: true,
      events: ['CONNECTION_UPDATE'],
    });

    await outbox.enqueue(connectionUpdate(instance.id));

    const [row] = await db.webhookDelivery.findMany();
    expect(row.url).toBe('https://consumer.example/hook/connection-update');
    // The suffix changes the target, never the body.
    expect((row.payload as { destination: string }).destination).toBe('https://consumer.example/hook');
  });

  it('skips an unconfigured instance, a disabled hook, and an unselected event', async () => {
    const unconfigured = await setup(null);
    expect(await unconfigured.outbox.enqueue(connectionUpdate(unconfigured.instance.id))).toBe(false);

    const disabled = await setup({ enabled: false, url: 'https://consumer.example/hook', events: [] });
    expect(await disabled.outbox.enqueue(connectionUpdate(disabled.instance.id))).toBe(false);

    const unselected = await setup({
      enabled: true,
      url: 'https://consumer.example/hook',
      events: ['MESSAGES_UPSERT'],
    });
    expect(await unselected.outbox.enqueue(connectionUpdate(unselected.instance.id))).toBe(false);

    expect(await unselected.db.webhookDelivery.count()).toBe(0);
  });

  it('collapses a repeated occurrence into one job', async () => {
    const { db, instance, outbox } = await setup();

    expect(await outbox.enqueue(connectionUpdate(instance.id))).toBe(true);
    expect(await outbox.enqueue(connectionUpdate(instance.id, { id: 'delivery-2' }))).toBe(false);

    expect(await db.webhookDelivery.count()).toBe(1);
  });

  it('enqueues from an instance lifecycle event', async () => {
    const { db, instance, outbox } = await setup();

    await outbox.handle({
      type: 'updated',
      change: 'connection',
      instance: { id: instance.id, name: 'acme', status: 'open' },
    });

    const [row] = await db.webhookDelivery.findMany();
    expect(row.event).toBe('CONNECTION_UPDATE');
  });

  it('queues SEND_MESSAGE for an outbound message', async () => {
    const { db, instance, outbox } = await setup({
      enabled: true,
      url: 'https://consumer.example/hook',
      events: ['SEND_MESSAGE'],
    });

    await outbox.handle({
      type: 'sent',
      instance: { id: instance.id, name: 'acme', status: 'open' },
      message: {
        key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: true, id: 'SENT-1' },
        message: { conversation: 'hola' },
        messageType: 'conversation',
        messageTimestamp: 1756555200,
        instanceId: instance.id,
      },
    });

    const [row] = await db.webhookDelivery.findMany();
    expect(row.event).toBe('SEND_MESSAGE');
    expect(row.payload).toMatchObject({
      event: 'send.message',
      data: { key: { id: 'SENT-1' }, message: { conversation: 'hola' } },
    });
  });

  it.each([
    [false, undefined],
    [true, Buffer.from('sticker-bytes').toString('base64')],
  ])('includes media Base64 only when the webhook flag is %s', async (base64, expected) => {
    const { db, instance, outbox } = await setup({
      enabled: true,
      url: 'https://consumer.example/hook',
      events: ['MESSAGES_UPSERT'],
      base64,
    });

    await outbox.enqueue(mediaMessage(instance.id));

    const [row] = await db.webhookDelivery.findMany();
    expect((row.payload as { data: { message: { base64?: string } } }).data.message.base64).toBe(expected);
  });

  it('includes media Base64 for an enabled outbound send webhook', async () => {
    const { db, instance, outbox } = await setup({
      enabled: true,
      url: 'https://consumer.example/hook',
      events: ['SEND_MESSAGE'],
      base64: true,
    });

    await outbox.enqueue(mediaMessage(instance.id, 'SEND_MESSAGE'));

    const [row] = await db.webhookDelivery.findMany();
    expect((row.payload as { data: { message: { base64?: string } } }).data.message.base64).toBe(
      Buffer.from('sticker-bytes').toString('base64'),
    );
  });

  it('does not embed media over the outbound media limit', async () => {
    const { db, instance, outbox } = await setup({
      enabled: true,
      url: 'https://consumer.example/hook',
      events: ['MESSAGES_UPSERT'],
      base64: true,
    });

    await outbox.enqueue(mediaMessage(instance.id, 'MESSAGES_UPSERT', Buffer.alloc(MAX_OUTBOUND_MEDIA_BYTES + 1)));

    const [row] = await db.webhookDelivery.findMany();
    expect((row.payload as { data: { message: { base64?: string } } }).data.message.base64).toBeUndefined();
  });

  it('queues SEND_MESSAGE_UPDATE with the reference protocol payload', async () => {
    const { db, instance, outbox } = await setup({
      enabled: true,
      url: 'https://consumer.example/webhooks/whatsapp',
      events: ['SEND_MESSAGE_UPDATE'],
    });

    await outbox.handle({
      type: 'sent-message-update',
      instance: { id: instance.id, name: 'acme', status: 'open', user: '5511999999999@s.whatsapp.net' },
      message: {
        key: updateEnvelope.data.key,
        data: updateEnvelope.data,
        message: updateEnvelope.data.editedMessage,
        messageType: 'conversation',
        messageTimestamp: 1756555300,
      },
    });

    const [delivery] = await db.webhookDelivery.findMany();
    expect(delivery.payload).toMatchObject({ event: updateEnvelope.event, data: updateEnvelope.data });
  });

  it('does not queue a send the instance has not subscribed to', async () => {
    const { db, instance, outbox } = await setup({
      enabled: true,
      url: 'https://consumer.example/hook',
      events: ['MESSAGES_UPSERT'],
    });

    await outbox.handle({
      type: 'sent',
      instance: { id: instance.id, name: 'acme', status: 'open' },
      message: {
        key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: true, id: 'SENT-2' },
        message: { conversation: 'hola' },
        messageType: 'conversation',
        messageTimestamp: 1756555200,
        instanceId: instance.id,
      },
    });

    expect(await db.webhookDelivery.count()).toBe(0);
  });
});
