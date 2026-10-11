import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createDeliveryHandler } from '../../src/delivery';
import { createMessageService } from '../../src/messages';
import { createOutbox } from '../../src/outbox';
import { createDatabaseQueue } from '../../src/queue';
import { createWebhookService } from '../../src/webhooks';
import type { Instance } from '../../src/instances';
import { createTestDb, silentLogger } from '../helpers';

type ReceivedRequest = { headers: Record<string, string | string[] | undefined>; body: unknown };

async function createConsumer(): Promise<{ url: string; received: Promise<ReceivedRequest>; close(): Promise<void> }> {
  let receive!: (request: ReceivedRequest) => void;
  const received = new Promise<ReceivedRequest>((resolve) => {
    receive = resolve;
  });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      receive({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('consumer did not bind a TCP port');

  return {
    url: `http://127.0.0.1:${address.port}/webhooks/whatsapp`,
    received,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

describe('webhook delivery', () => {
  it('persists an inbound message, queues it, and delivers its envelope to a configured HTTP consumer', async () => {
    const consumer = await createConsumer();
    try {
      const db = createTestDb();
      const logger = silentLogger();
      const record = await db.instanceRecord.create({ data: { name: 'acme' } });
      const instance: Instance = { id: record.id, name: record.name, status: 'open' };
      const webhooks = createWebhookService({ db, allowInsecureUrls: false });
      await webhooks.setWebhook(instance.name, {
        webhook: {
          enabled: true,
          url: consumer.url,
          headers: { 'X-Customer': 'acme' },
          events: ['MESSAGES_UPSERT'],
        },
      });

      const queue = createDatabaseQueue({ db, logger });
      const outbox = createOutbox({ db, queue, logger, serverUrl: 'http://localhost:3000' });
      const messages = createMessageService({ db, outbox, logger });
      await messages.ingest(instance, [
        {
          key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: false, id: 'MESSAGE-1' },
          message: { conversation: 'hello' },
          messageType: 'conversation',
          messageTimestamp: 1756555200,
          instanceId: instance.id,
          status: 'DELIVERY_ACK',
        },
      ]);

      expect(await queue.drain(createDeliveryHandler({ db, logger, allowInsecureUrls: false }))).toBe(1);

      const request = await consumer.received;
      expect(request.headers).toMatchObject({
        'content-type': 'application/json',
        'x-customer': 'acme',
        'x-event-type': 'MESSAGES_UPSERT',
      });
      expect(request.body).toMatchObject({
        event: 'messages.upsert',
        instance: 'acme',
        data: { key: { id: 'MESSAGE-1' }, message: { conversation: 'hello' }, instanceId: instance.id },
      });
      const [delivery] = await db.webhookDelivery.findMany();
      expect(delivery).toMatchObject({ event: 'MESSAGES_UPSERT', status: 'delivered', attempts: 1, responseStatus: 204 });
    } finally {
      await consumer.close();
    }
  });
});
