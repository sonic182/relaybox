import pino, { type Logger } from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, expect, vi } from 'vitest';
import { createControlService, createControlValidator } from '../src/api/control';
import { createApp } from '../src/app';
import { createDatabasePool, createDb } from '../src/db';
import { InstanceNotConnectedError, toRecipientJid, type Instance, type InstanceService } from '../src/instances';
import { createChatService, type ChatService } from '../src/chats';
import { createSendService, type SendService } from '../src/sends';
import { createSettingsService } from '../src/settings';
import { createWebhookService } from '../src/webhooks';

/** The test setup migrates and clears this isolated PostgreSQL database before every test. */
const testPool = createDatabasePool();
const testDb = createDb(testPool);
const controlValidator = await createControlValidator();
beforeEach(async () => {
  await testPool.query('TRUNCATE TABLE "WebhookDelivery", "Message", "Chat", "WebhookConfig", "InstanceRecord" CASCADE');
});
afterAll(() => testPool.end());

export function createTestDb() {
  return testDb;
}

/** Stand-in for controller tests that must not open WhatsApp sockets. */
export function createFakeInstanceService(): InstanceService {
  const instances: Instance[] = [];
  const requireConnected = (name: string) => {
    const instance = instances.find((item) => item.name === name);
    if (!instance) throw new Error(`The "${name}" instance does not exist`);
    if (instance.status !== 'open') throw new InstanceNotConnectedError(name);
    return instance;
  };

  return {
    listInstances: () => instances,
    getInstance: (name) => instances.find((instance) => instance.name === name),
    createInstance: vi.fn(async (name) => {
      const instance: Instance = { id: `id-${name}`, name, status: 'connecting' };
      instances.push(instance);
      return instance;
    }),
    sendText: vi.fn(async (name, number, text) => {
      const instance = requireConnected(name);

      return {
        key: { remoteJid: toRecipientJid(number), fromMe: true, id: 'SENT-1' },
        message: { conversation: text },
        messageType: 'conversation',
        messageTimestamp: 1756555200,
        instanceId: instance.id,
        status: 'PENDING',
      };
    }),
    sendMedia: vi.fn(async (name, number, mediatype) => {
      const instance = requireConnected(name);

      const messageType = `${mediatype}Message`;
      return {
        key: { remoteJid: toRecipientJid(number), fromMe: true, id: 'SENT-MEDIA-1' },
        message: { [messageType]: {} },
        messageType,
        messageTimestamp: 1756555200,
        instanceId: instance.id,
        status: 'PENDING',
      };
    }),
    sendAudio: vi.fn(async (name, number) => {
      const instance = requireConnected(name);

      return {
        key: { remoteJid: toRecipientJid(number), fromMe: true, id: 'SENT-AUDIO-1' },
        message: { audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus' } },
        messageType: 'audioMessage',
        messageTimestamp: 1756555200,
        instanceId: instance.id,
        status: 'PENDING',
      };
    }),
    downloadMessageMedia: vi.fn(async () => undefined),
    getProfilePictureUrl: vi.fn(async () => undefined),
    getBusinessProfile: vi.fn(async () => undefined),
    editMessage: vi.fn(async (name, input) => {
      requireConnected(name);

      return {
        key: { remoteJid: input.key.remoteJid, fromMe: true, id: 'EDIT-OUT-1' },
        message: {
          protocolMessage: {
            key: input.key,
            editedMessage: { conversation: input.text },
            type: 'MESSAGE_EDIT',
          },
        },
        messageTimestamp: 1756555300,
        status: 'PENDING',
      };
    }),
    renameInstance: vi.fn(async (name, newName) => {
      const instance = instances.find((item) => item.name === name);
      if (instance) instance.name = newName;
    }),
    disconnectInstance: vi.fn(async (name) => {
      const instance = instances.find((item) => item.name === name);
      if (instance) instance.status = 'close';
    }),
    logoutInstance: vi.fn(async (name) => {
      const instance = instances.find((item) => item.name === name);
      if (instance) {
        instance.status = 'close';
        instance.loggedOut = true;
      }
    }),
    reconnectInstance: vi.fn(async (name) => {
      const instance = instances.find((item) => item.name === name);
      if (instance) instance.status = 'open';
    }),
    setOnlinePresence: vi.fn(async () => {}),
    deleteInstance: vi.fn(async (name) => {
      const index = instances.findIndex((instance) => instance.name === name);
      if (index >= 0) instances.splice(index, 1);
    }),
    restoreInstances: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
  };
}

/** Runs `send` immediately, so a test asserts the send path without idempotency bookkeeping. */
export function createFakeSendService(): SendService {
  return {
    once: vi.fn(async (_instanceId, _key, send) => send()),
    pruneCompleted: vi.fn(async () => 0),
  };
}

/** Empty chat reads by default; override the method a test cares about. */
export function createFakeChatService(overrides: Partial<ChatService> = {}): ChatService {
  return {
    listChats: vi.fn(async () => ({ chats: [], cursor: null })),
    listMessages: vi.fn(async () => ({ messages: [], cursor: null })),
    findMessage: vi.fn(async () => null),
    getMedia: vi.fn(async () => null),
    ...overrides,
  };
}

type AppDependencies = Parameters<typeof createApp>[0];

/** The app wired to fakes and a throwaway database; override what a test cares about. */
export function createTestApp(deps: Partial<AppDependencies> = {}) {
  const instanceService = deps.instanceService ?? createFakeInstanceService();
  const webhookService = deps.webhookService ?? createWebhookService({ db: createTestDb() });
  const settingsService = deps.settingsService ?? createSettingsService({ db: createTestDb(), applyPresence: instanceService.setOnlinePresence });
  return createApp({
    settingsService,
    sendService: createSendService({ db: createTestDb(), logger: silentLogger() }),
    chatService: createChatService({ db: createTestDb() }),
    controlService: createControlService({
      validator: controlValidator, instanceService, webhookService, settingsService,
      logger: deps.logger ?? silentLogger(),
    }),
    ...deps,
    instanceService,
    webhookService,
  });
}

export async function createAuthenticatedAgent(deps: Partial<AppDependencies> = {}) {
  const agent = request.agent(createTestApp(deps));
  await agent.post('/login').type('form').send({ token: 'test-api-key-0000' }).expect(200);
  return agent;
}

export async function createSendTestApp(status: 'open' | 'close' = 'open') {
  const instanceService = createFakeInstanceService();
  const instance = await instanceService.createInstance('acme');
  const live = instanceService.getInstance('acme');
  if (live) live.status = status;
  const db = createTestDb();
  await db.instanceRecord.upsert({
    where: { id: instance.id },
    create: { id: instance.id, name: `acme-${instance.id}` },
    update: {},
  });

  return {
    instanceService,
    app: createTestApp({ instanceService, sendService: createSendService({ db, logger: silentLogger() }) }),
  };
}

export async function createTestDbWithInstance(name: string) {
  const db = createTestDb();
  const instance = await db.instanceRecord.create({ data: { name } });
  return { db, instance };
}

export function expectSseHeaders(res: { set: (...args: unknown[]) => unknown; flushHeaders: () => unknown }) {
  expect(res.set).toHaveBeenCalledWith({
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream',
  });
  expect(res.flushHeaders).toHaveBeenCalledOnce();
}

/** A logger that records nothing, so a test never depends on log output. */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
