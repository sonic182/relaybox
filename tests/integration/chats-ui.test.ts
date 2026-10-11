import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonObject } from '@zenstackhq/orm';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createChatService } from '../../src/chats';
import { MEDIA_DIR } from '../../src/instances';
import { createAuthenticatedAgent, createFakeInstanceService, createTestApp, createTestDb } from '../helpers';

const TEST_TOKEN = 'test-api-key-0000';

let instanceNumber = 0;

async function agentWithChat(messages: { keyId: string; at: number; text?: string; fromMe?: boolean; status?: string }[] = []) {
  const db = createTestDb();
  const name = `acme${++instanceNumber}`;
  const instance = await db.instanceRecord.create({ data: { name } });

  if (messages.length) {
    await db.chat.create({
      data: {
        instanceId: instance.id,
        remoteJid: 'alex@s.whatsapp.net',
        name: 'Alex Doe',
        lastMessageAt: new Date('2026-08-30T12:00:00Z'),
        lastMessagePreview: 'hola',
      },
    });
  }

  for (const entry of messages) {
    await db.message.create({
      data: {
        instanceId: instance.id,
        remoteJid: 'alex@s.whatsapp.net',
        keyId: entry.keyId,
        fromMe: entry.fromMe ?? false,
        messageType: entry.text === undefined ? 'imageMessage' : 'conversation',
        messageTimestamp: entry.at,
        ...(entry.status ? { status: entry.status } : {}),
        content: (entry.text === undefined
          ? { imageMessage: { mediaKey: 'super-secret' } }
          : { conversation: entry.text }) as JsonObject,
      },
    });
  }

  const agent = request.agent(createTestApp({ chatService: createChatService({ db }) }));
  await agent.post('/login').type('form').send({ token: TEST_TOKEN }).expect(200);

  return { agent, db, name };
}

describe('chat browser', () => {
  it('requires the dashboard cookie', async () => {
    const app = createTestApp();

    await request(app).get('/instances/acme/chats').expect(302).expect('Location', '/login');
    await request(app).get('/instances/acme/chats/messages?jid=x').expect(302).expect('Location', '/login');
  });

  it('lists chats and says so when there are none', async () => {
    const { agent, name } = await agentWithChat();

    const response = await agent.get(`/instances/${name}/chats`).expect(200);

    expect(response.text).toContain('No chats yet.');
    expect(response.text).toContain('Pick a chat to read it.');
  });

  it('reads a selected chat oldest first', async () => {
    const { agent, name } = await agentWithChat([
      { keyId: 'a', at: 1756555200, text: 'primero' },
      { keyId: 'b', at: 1756555260, text: 'segundo' },
    ]);

    const response = await agent
      .get(`/instances/${name}/chats?jid=${encodeURIComponent('alex@s.whatsapp.net')}`)
      .expect(200);

    expect(response.text).toContain('Alex Doe');
    expect(response.text.indexOf('primero')).toBeLessThan(response.text.indexOf('segundo'));
  });

  // The stored payload holds media keys and raw Baileys content.
  it('describes a media message by its type and never renders the payload', async () => {
    const { agent, name } = await agentWithChat([{ keyId: 'a', at: 1756555200 }]);

    const response = await agent
      .get(`/instances/${name}/chats?jid=${encodeURIComponent('alex@s.whatsapp.net')}`)
      .expect(200);

    expect(response.text).toContain('imageMessage');
    expect(response.text).not.toContain('super-secret');
  });

  it('hides the stored content of a revoked message', async () => {
    const { agent, name } = await agentWithChat([
      { keyId: 'a', at: 1756555200, text: 'this must disappear', status: 'DELETED' },
    ]);

    const response = await agent
      .get(`/instances/${name}/chats?jid=${encodeURIComponent('alex@s.whatsapp.net')}`)
      .expect(200);

    expect(response.text).toContain('Deleted');
    expect(response.text).not.toContain('this must disappear');
  });

  // Message text is written by strangers, so it must never be markup.
  it('escapes message content', async () => {
    const { agent, name } = await agentWithChat([
      { keyId: 'a', at: 1756555200, text: '<img src=x onerror=alert(1)>' },
    ]);

    const response = await agent
      .get(`/instances/${name}/chats?jid=${encodeURIComponent('alex@s.whatsapp.net')}`)
      .expect(200);

    expect(response.text).not.toContain('<img src=x');
    expect(response.text).toContain('&lt;img src=x');
  });

  // One more than a page, so the first view genuinely cannot show the oldest message.
  it('loads older messages through the pagination fragment', async () => {
    const conversation = Array.from({ length: 31 }, (_, index) => ({
      keyId: `m${index}`,
      at: 1756555200 + index,
      text: index === 0 ? 'el primero de todos' : `mensaje ${index}`,
    }));
    const { agent, name } = await agentWithChat(conversation);
    const jid = encodeURIComponent('alex@s.whatsapp.net');

    const first = await agent.get(`/instances/${name}/chats?jid=${jid}`).expect(200);
    expect(first.text).toContain('mensaje 30');
    expect(first.text).not.toContain('el primero de todos');

    // Follow the button the page rendered rather than guessing the cursor.
    const url = /hx-get="([^"]*chats\/messages[^"]*)"/.exec(first.text)?.[1];
    if (!url) throw new Error('the page offered no older-messages link');

    const older = await agent.get(url.replace(/&amp;/g, '&')).expect(200);
    expect(older.text).toContain('el primero de todos');
  });

  // In a one-to-one chat the sender is obvious; in a group it is not.
  it('names the sender of each incoming message in a group', async () => {
    const db = createTestDb();
    const name = `acme${++instanceNumber}`;
    const instance = await db.instanceRecord.create({ data: { name } });
    const remoteJid = '5511999990003-1700000000@g.us';

    await db.chat.create({ data: { instanceId: instance.id, remoteJid } });
    await db.message.create({
      data: {
        instanceId: instance.id,
        remoteJid,
        keyId: 'a',
        fromMe: false,
        pushName: 'Sam Rivera',
        messageType: 'conversation',
        messageTimestamp: 1756555200,
        content: { conversation: 'O te hiciste el desriss' } as JsonObject,
      },
    });

    const agent = request.agent(createTestApp({ chatService: createChatService({ db }) }));
    await agent.post('/login').type('form').send({ token: TEST_TOKEN }).expect(200);

    const response = await agent
      .get(`/instances/${name}/chats?jid=${encodeURIComponent(remoteJid)}`)
      .expect(200);

    expect(response.text).toContain('Sam Rivera');
    // The group itself has no name, so the list falls back to its JID.
    expect(response.text).toContain(remoteJid);
  });

  it('does not label the sender in a one-to-one chat', async () => {
    const { agent, name } = await agentWithChat([{ keyId: 'a', at: 1756555200, text: 'hola' }]);

    const response = await agent
      .get(`/instances/${name}/chats?jid=${encodeURIComponent('alex@s.whatsapp.net')}`)
      .expect(200);

    // "Alex Doe" is the chat's own name in the list, never a per-message label.
    expect(response.text.match(/Alex Doe/g)).toHaveLength(1);
  });

  describe('replying', () => {
    async function agentThatCanSend(status: 'open' | 'close' = 'open', echoedText?: string) {
      const db = createTestDb();
      const name = `acme${++instanceNumber}`;
      const instance = await db.instanceRecord.create({ data: { name } });
      await db.chat.create({ data: { instanceId: instance.id, remoteJid: 'alex@s.whatsapp.net' } });
      if (echoedText) {
        await db.message.create({
          data: {
            instanceId: instance.id,
            remoteJid: 'alex@s.whatsapp.net',
            keyId: 'SENT-1',
            fromMe: true,
            messageType: 'conversation',
            messageTimestamp: 1756555200,
            content: { conversation: echoedText } as JsonObject,
          },
        });
      }

      const instanceService = createFakeInstanceService();
      await instanceService.createInstance(name);
      const live = instanceService.getInstance(name);
      if (live) live.status = status;

      const agent = request.agent(
        createTestApp({ chatService: createChatService({ db }), instanceService }),
      );
      await agent.post('/login').type('form').send({ token: TEST_TOKEN }).expect(200);

      return { agent, name, instanceService };
    }

    it('offers a reply box on a selected chat', async () => {
      const { agent, name } = await agentThatCanSend();

      const response = await agent
        .get(`/instances/${name}/chats?jid=${encodeURIComponent('alex@s.whatsapp.net')}`)
        .expect(200);

      expect(response.text).toContain('Write a reply…');
      expect(response.text).toContain('hx-target="#chat-timeline"');
      expect(response.text).toContain('hx-swap="beforeend"');
    });

    // The send response is appended immediately; the stored echo can arrive later.
    it('sends and shows the reply straight away', async () => {
      const { agent, name, instanceService } = await agentThatCanSend();

      const response = await agent
        .post(`/instances/${name}/chats/send`)
        .type('form')
        .send({ jid: 'alex@s.whatsapp.net', text: 'hola desde el panel' })
        .expect(200);

      expect(instanceService.sendText).toHaveBeenCalledWith(name, 'alex@s.whatsapp.net', 'hola desde el panel');
      expect(response.text).toContain('hola desde el panel');
      expect(response.text).toContain('id="message-status-SENT-1"');
      expect(response.text).not.toContain('id="conversation"');
    });

    // The fake returns key.id 'SENT-1'; if the echo has already stored that message the
    // controller must not append its own copy on top of it.
    it('shows one bubble when the echo has already been persisted', async () => {
      const { agent, name } = await agentThatCanSend('open', 'ya estaba');

      const response = await agent
        .post(`/instances/${name}/chats/send`)
        .type('form')
        .send({ jid: 'alex@s.whatsapp.net', text: 'ya estaba' })
        .expect(200);

      expect(response.text.match(/ya estaba/g)).toHaveLength(1);
    });

    it('reports a send that failed and hands the text back', async () => {
      const { agent, name } = await agentThatCanSend('close');

      const response = await agent
        .post(`/instances/${name}/chats/send`)
        .type('form')
        .send({ jid: 'alex@s.whatsapp.net', text: 'hola' })
        .expect(400);

      expect(response.text).toContain('is not connected');
      // The box is still there and still holds the text, so it can be retried.
      expect(response.text).toContain('Write a reply…');
      expect(response.text).toContain('>hola</textarea>');
    });

    it('refuses blank text rather than sending an empty message', async () => {
      const { agent, name, instanceService } = await agentThatCanSend();

      await agent
        .post(`/instances/${name}/chats/send`)
        .type('form')
        .send({ jid: 'alex@s.whatsapp.net', text: '   ' })
        .expect(400);

      expect(instanceService.sendText).not.toHaveBeenCalled();
    });

    it('refuses a send with no chat', async () => {
      const { agent, name, instanceService } = await agentThatCanSend();

      await agent.post(`/instances/${name}/chats/send`).type('form').send({ text: 'hola' }).expect(400);

      expect(instanceService.sendText).not.toHaveBeenCalled();
    });

    it('requires the dashboard cookie', async () => {
      await request(createTestApp())
        .post('/instances/acme/chats/send')
        .type('form')
        .send({ jid: 'x', text: 'y' })
        .expect(302);
    });
  });

  it('rejects a request with no chat selected on the fragment route', async () => {
    const { agent, name } = await agentWithChat();

    await agent.get(`/instances/${name}/chats/messages`).expect(400);
  });

  it('never shows another instance a chat', async () => {
    const { agent } = await agentWithChat([{ keyId: 'a', at: 1756555200, text: 'privado' }]);
    const other = createTestDb();
    const stranger = await other.instanceRecord.create({ data: { name: `globex${++instanceNumber}` } });

    const response = await agent
      .get(`/instances/${stranger.name}/chats?jid=${encodeURIComponent('alex@s.whatsapp.net')}`)
      .expect(200);

    expect(response.text).not.toContain('privado');
  });
});

describe('profile avatar route', () => {
  it('redirects an authenticated browser to WhatsApp’s profile picture', async () => {
    const instanceService = createFakeInstanceService();
    vi.mocked(instanceService.getProfilePictureUrl).mockResolvedValue('https://cdn.example/avatar.jpg');
    const agent = await createAuthenticatedAgent({ instanceService });

    await agent
      .get('/instances/acme/chats/avatar?jid=5511999990002%40s.whatsapp.net')
      .expect(302)
      .expect('Location', 'https://cdn.example/avatar.jpg');

    expect(instanceService.getProfilePictureUrl).toHaveBeenCalledWith('acme', '5511999990002@s.whatsapp.net');
  });

  it('uses the initial fallback when WhatsApp has no picture', async () => {
    const instanceService = createFakeInstanceService();
    const agent = await createAuthenticatedAgent({ instanceService });

    await agent.get('/instances/acme/chats/avatar?jid=5511999990002%40s.whatsapp.net').expect(404);
  });
});

describe('media route', () => {
  async function agentWithImage(messageType = 'imageMessage', mimetype = 'image/jpeg') {
    const { agent, db, name } = await agentWithChat();
    const instance = await db.instanceRecord.findFirstOrThrow({ where: { name } });
    const created = await db.message.create({
      data: {
        instanceId: instance.id,
        remoteJid: 'alex@s.whatsapp.net',
        keyId: 'IMG-1',
        fromMe: false,
        messageType,
        messageTimestamp: 1756555200,
        content: { imageMessage: { mediaKey: 'never-shown' } } as JsonObject,
      },
    });
    await db.media.create({ data: { messageId: created.id, path: 'IMG-1.jpg', mimetype } });
    mkdirSync(join(MEDIA_DIR, name), { recursive: true });
    writeFileSync(join(MEDIA_DIR, name, 'IMG-1.jpg'), 'pixels');

    return { agent, db, name, created };
  }

  it('requires the dashboard cookie', async () => {
    const app = createTestApp();

    await request(app).get('/instances/acme/media/IMG-1').expect(302).expect('Location', '/login');
  });

  it('serves the stored file with its mimetype', async () => {
    const { agent, name } = await agentWithImage();

    const response = await agent.get(`/instances/${name}/media/IMG-1`).expect(200);

    // Binary responses land in the body buffer, not `.text`.
    expect(response.body.toString()).toBe('pixels');
    expect(response.headers['content-type']).toContain('image/jpeg');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('downloads HTML documents instead of serving them inline', async () => {
    const { agent, name } = await agentWithImage('documentMessage', 'text/html');

    const response = await agent.get(`/instances/${name}/media/IMG-1`).expect(200);

    expect(response.headers['content-disposition']).toMatch(/^attachment/);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('does not serve revoked media', async () => {
    const { agent, db, name, created } = await agentWithImage();
    await db.message.update({ where: { id: created.id }, data: { status: 'DELETED' } });

    await agent.get(`/instances/${name}/media/IMG-1`).expect(404);
  });

  it('shows the image in the timeline instead of the type label', async () => {
    const { agent, name } = await agentWithImage();

    const response = await agent
      .get(`/instances/${name}/chats?jid=${encodeURIComponent('alex@s.whatsapp.net')}`)
      .expect(200);

    expect(response.text).toContain(`src="/instances/${name}/media/IMG-1"`);
    expect(response.text).not.toContain('imageMessage');
  });

  it('answers 404 for unknown keys and unknown instances', async () => {
    const { agent, name } = await agentWithImage();

    await agent.get(`/instances/${name}/media/ghost`).expect(404);
    await agent.get('/instances/ghost/media/IMG-1').expect(404);
  });
});
