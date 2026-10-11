import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonObject } from '@zenstackhq/orm';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createChatService } from '../../src/chats';
import { MEDIA_DIR } from '../../src/instances';
import updateMessage from '../fixtures/evolution/update-message.request.json';
import updateResponse from '../fixtures/evolution/update-message.response.json';
import { createFakeInstanceService, createSendTestApp, createTestApp, createTestDb } from '../helpers';

const API_KEY = 'test-api-key-0000';
let instanceNumber = 0;

async function mediaApp() {
  const db = createTestDb();
  const name = `media-api-${++instanceNumber}`;
  const instances = createFakeInstanceService();
  const instance = await instances.createInstance(name);
  const record = await db.instanceRecord.create({ data: { id: instance.id, name } });
  const message = await db.message.create({
    data: {
      instanceId: record.id,
      remoteJid: '5511888888888@s.whatsapp.net',
      keyId: 'STICKER-1',
      fromMe: false,
      pushName: 'Jane',
      messageType: 'stickerMessage',
      messageTimestamp: 1756555200,
      content: { stickerMessage: { mimetype: 'image/webp' } } as JsonObject,
    },
  });
  await db.media.create({ data: { messageId: message.id, path: 'STICKER-1.webp', mimetype: 'image/webp' } });
  mkdirSync(join(MEDIA_DIR, name), { recursive: true });
  writeFileSync(join(MEDIA_DIR, name, 'STICKER-1.webp'), 'sticker-bytes');

  return {
    app: createTestApp({ instanceService: instances, chatService: createChatService({ db }) }),
    name,
    instanceId: record.id,
  };
}

describe('Evolution chat media API', () => {
  it('returns a stored sticker as the Base64 response Atenea consumes', async () => {
    const { app, name } = await mediaApp();

    const response = await request(app)
      .post(`/chat/getBase64FromMediaMessage/${name}`)
      .set('apikey', API_KEY)
      .send({ message: { key: { id: 'STICKER-1' }, message: { stickerMessage: {} } }, convertToMp4: false })
      .expect(201);

    expect(response.body).toEqual({
      mediaType: 'stickerMessage',
      fileName: 'STICKER-1.webp',
      mimetype: 'image/webp',
      base64: Buffer.from('sticker-bytes').toString('base64'),
    });
  });

  it('finds an Evolution record by its WhatsApp key ID', async () => {
    const { app, name, instanceId } = await mediaApp();

    const response = await request(app)
      .post(`/chat/findMessages/${name}`)
      .set('apikey', API_KEY)
      .send({ where: { key: { id: 'STICKER-1' } } })
      .expect(200);

    expect(response.body).toEqual({
      messages: {
        records: [
          {
            key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: false, id: 'STICKER-1' },
            pushName: 'Jane',
            message: { stickerMessage: { mimetype: 'image/webp' } },
            contextInfo: null,
            messageType: 'stickerMessage',
            messageTimestamp: 1756555200,
            // Same shape a send returns, so a consumer reads one message format.
            instanceId,
            status: null,
          },
        ],
      },
    });
  });

  it('requires an API key and a stored media file', async () => {
    const { app, name } = await mediaApp();

    await request(app)
      .post(`/chat/getBase64FromMediaMessage/${name}`)
      .send({ message: { key: { id: 'STICKER-1' } } })
      .expect(401);
    await request(app)
      .post(`/chat/getBase64FromMediaMessage/${name}`)
      .set('apikey', API_KEY)
      .send({ message: { key: { id: 'missing' } } })
      .expect(404);
  });

  it('rejects unsupported MP4 conversion requests', async () => {
    const { app, name } = await mediaApp();

    await request(app)
      .post(`/chat/getBase64FromMediaMessage/${name}`)
      .set('apikey', API_KEY)
      .send({ message: { key: { id: 'STICKER-1' } }, convertToMp4: true })
      .expect(400);
  });
});

describe('POST /chat/updateMessage/:instanceName', () => {
  it('reproduces the reference request and response shapes', async () => {
    const { instanceService, app } = await createSendTestApp();

    const response = await request(app)
      .post('/chat/updateMessage/acme')
      .set('apikey', API_KEY)
      .send(updateMessage)
      .expect(200);

    expect(response.body).toEqual(updateResponse);
    expect(instanceService.editMessage).toHaveBeenCalledWith('acme', updateMessage);
  });

  it.each([
    ['missing number', { ...updateMessage, number: undefined }],
    ['blank text', { ...updateMessage, text: '   ' }],
    ['missing key', { number: updateMessage.number, text: updateMessage.text }],
    ['incomplete key', { ...updateMessage, key: { id: 'message-id' } }],
    ['editing someone else\'s message', { ...updateMessage, key: { ...updateMessage.key, fromMe: false } }],
    ['a key from another chat', { ...updateMessage, key: { ...updateMessage.key, remoteJid: '5511999999999@s.whatsapp.net' } }],
    ['a jid with no local part', { ...updateMessage, number: '@' }],
  ])('rejects %s', async (_label, body) => {
    const { instanceService, app } = await createSendTestApp();

    await request(app).post('/chat/updateMessage/acme').set('apikey', API_KEY).send(body).expect(400);

    expect(instanceService.editMessage).not.toHaveBeenCalled();
  });

  it('requires a connected existing instance and the API key', async () => {
    const disconnected = await createSendTestApp('close');
    await request(disconnected.app)
      .post('/chat/updateMessage/acme')
      .set('apikey', API_KEY)
      .send(updateMessage)
      .expect(400);

    const missing = await createSendTestApp();
    await request(missing.app).post('/chat/updateMessage/ghost').set('apikey', API_KEY).send(updateMessage).expect(404);

    const authenticated = await createSendTestApp();
    await request(authenticated.app).post('/chat/updateMessage/acme').send(updateMessage).expect(401);
  });

  it('replays an idempotent edit without calling WhatsApp twice', async () => {
    const { instanceService, app } = await createSendTestApp();

    const first = await request(app)
      .post('/chat/updateMessage/acme')
      .set('apikey', API_KEY)
      .set('Idempotency-Key', 'edit-42')
      .send(updateMessage)
      .expect(200);
    const replay = await request(app)
      .post('/chat/updateMessage/acme')
      .set('apikey', API_KEY)
      .set('Idempotency-Key', 'edit-42')
      .send(updateMessage)
      .expect(200);

    expect(replay.body).toEqual(first.body);
    expect(instanceService.editMessage).toHaveBeenCalledOnce();
  });
});
