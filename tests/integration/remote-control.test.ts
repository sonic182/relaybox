import { once } from 'node:events';
import pino from 'pino';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createControlService, createControlValidator } from '../../src/api/control';
import { createRemoteClient } from '../../src/remote';
import { createSettingsService } from '../../src/settings';
import type { WebhookService } from '../../src/webhooks';
import { createFakeTarget } from '../fakeRemoteTarget';
import { createFakeInstanceService, createTestApp, createTestDb } from '../helpers';

async function startControlFixture() {
  const target = await createFakeTarget();
  const logger = pino({ level: 'silent' });
  const instanceService = createFakeInstanceService();
  const webhook = { url: 'https://hooks.example.test/events', enabled: true };
  const setWebhook = vi.fn(async () => webhook);
  const webhookService = {
    validateWebhook: vi.fn(),
    setWebhook,
    getWebhook: vi.fn(async () => webhook),
  } as unknown as WebhookService;
  const settingsService = createSettingsService({ db: createTestDb() });
  const control = createControlService({ validator: await createControlValidator(), instanceService, webhookService, settingsService, logger });
  const app = createTestApp({ instanceService, webhookService, logger, controlService: control });
  const client = createRemoteClient({ target: { url: target.url, token: 'secret' }, logger, control });
  client.start();
  await target.connection(1);

  const send = async (frame: unknown) => {
    const reply = once(target.sockets[0], 'message');
    target.sockets[0].send(JSON.stringify(frame));
    const [data] = await reply;
    return JSON.parse(data.toString());
  };
  return {
    target,
    app,
    instanceService,
    setWebhook,
    send,
    close: async () => {
      await client.stop();
      await target.close();
    },
  };
}

describe('remote control frames', () => {
  it('shares instance and webhook operations with HTTP', async () => {
    const fixture = await startControlFixture();
    try {
      const created = await fixture.send({ type: 'request', requestId: 'create', method: 'POST', path: '/instance/create', body: { instanceName: 'acme' } });
      expect(created.status).toBe(201);
      expect(created.body.instance.instanceName).toBe('acme');

      const httpList = await request(fixture.app).get('/instance/fetchInstances').set('apikey', 'test-api-key-0000').expect(200);
      const wsList = await fixture.send({ type: 'request', requestId: 'list', method: 'GET', path: '/instance/fetchInstances' });
      expect(wsList).toEqual({ type: 'response', requestId: 'list', status: 200, body: httpList.body });

      const webhook = { url: 'https://hooks.example.test/events', enabled: true };
      const configured = await fixture.send({ type: 'request', requestId: 'webhook', method: 'POST', path: '/webhook/set/acme', body: { webhook } });
      expect(configured.status).toBe(201);
      expect(fixture.setWebhook).toHaveBeenCalledWith('acme', { webhook });

      const invalid = await fixture.send({ type: 'request', requestId: 'invalid', method: 'POST', path: '/instance/create', body: { instanceName: 'bad name' } });
      const httpInvalid = await request(fixture.app).post('/instance/create').set('apikey', 'test-api-key-0000').send({ instanceName: 'bad name' }).expect(400);
      expect(invalid.body).toEqual(httpInvalid.body);
    } finally {
      await fixture.close();
    }
  });

  it('returns protocol errors and drops requests without an ID', async () => {
    const fixture = await startControlFixture();
    try {
      const unknown = await fixture.send({ type: 'request', requestId: 'unknown', method: 'POST', path: '/message/sendText/acme' });
      expect(unknown.status).toBe(404);
      expect(unknown.body.response.message).toContain('Cannot POST');

      const malformed = await fixture.send({ type: 'request', requestId: 'malformed', method: 5, path: '/instance/create' });
      expect(malformed.status).toBe(400);

      const messages: unknown[] = [];
      const collect = (data: Buffer) => messages.push(JSON.parse(data.toString()));
      fixture.target.sockets[0].on('message', collect);
      fixture.target.sockets[0].send(JSON.stringify({ type: 'request', method: 'GET', path: '/instance/fetchInstances' }));
      const valid = await fixture.send({ type: 'request', requestId: 'valid', method: 'GET', path: '/instance/fetchInstances' });
      expect(valid.requestId).toBe('valid');
      expect(messages).toHaveLength(1);
      fixture.target.sockets[0].off('message', collect);
    } finally {
      await fixture.close();
    }
  });

  it('rejects malformed path encoding with a client error', async () => {
    const fixture = await startControlFixture();
    try {
      const path = '/instance/connectionState/%';
      const socket = await fixture.send({ type: 'request', requestId: 'bad-path', method: 'GET', path });
      expect(socket).toEqual({
        type: 'response', requestId: 'bad-path', status: 400,
        body: { status: 400, error: 'Bad Request', response: { message: 'Invalid request path' } },
      });

      const http = await request(fixture.app).get(path).set('apikey', 'test-api-key-0000').expect(400);
      expect(http.body).toEqual(socket.body);

      const dotted = await fixture.send({ type: 'request', requestId: 'dotted', method: 'POST', path: '/instance/rename/%2e%2e/create', body: { instanceName: 'sneaky' } });
      expect(dotted.status).toBe(400);
      expect(fixture.instanceService.listInstances()).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it('hides unexpected service failures', async () => {
    const fixture = await startControlFixture();
    try {
      fixture.instanceService.listInstances = () => { throw new Error('private failure'); };
      const failed = await fixture.send({ type: 'request', requestId: 'failed', method: 'GET', path: '/instance/fetchInstances' });
      expect(failed.status).toBe(500);
      expect(JSON.stringify(failed.body)).not.toContain('private failure');
    } finally {
      await fixture.close();
    }
  });
});
