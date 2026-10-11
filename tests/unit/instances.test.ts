import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_OUTBOUND_MEDIA_BYTES } from '../../src/config';
import { toDomainEvents } from '../../src/events';
import {
  createInstanceService,
  InstanceAlreadyExistsError,
  InstanceNameTakenError,
  isValidName,
  sleep,
  toRecipientJid,
  type InstanceEvent,
} from '../../src/instances';
import { fetchRemoteMedia } from '../../src/mediaFetch';
import updates from '../fixtures/evolution/messages-update.baileys.json';
import { createTestDb, silentLogger } from '../helpers';

// Real network access is never exercised here; sendMedia's own decoding/size-cap logic is.
// The error class stays real so the assertions below see the message, not a stub.
vi.mock('../../src/mediaFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/mediaFetch')>()),
  fetchRemoteMedia: vi.fn(),
}));

type MockSocket = {
  ev: import('node:events').EventEmitter;
  auth?: import('baileys').AuthenticationState;
  sendMessage?: unknown;
  groupFetchAllParticipating?: () => Promise<unknown>;
  updateMediaMessage?: () => Promise<void>;
};

// Every mocked socket, so a test can drive the Baileys callbacks and stub its sends.
const { sockets, downloadMediaMessage } = vi.hoisted(() => ({
  sockets: [] as MockSocket[],
  downloadMediaMessage: vi.fn(async () => Readable.from([Buffer.from('media-bytes')])),
}));

/** The socket opened most recently. */
function socket(): MockSocket {
  const last = sockets[sockets.length - 1];
  if (!last) throw new Error('no socket was opened');
  return last;
}

async function saveAuthState(): Promise<void> {
  const auth = socket().auth;
  if (!auth) throw new Error('socket has no auth state');
  await auth.keys.set({ session: { peer: Buffer.from('key') } });
}

// The service must never open a real WhatsApp socket in tests.
vi.mock('baileys', async (importOriginal) => {
  const { proto } = await importOriginal<typeof import('baileys')>();
  const { EventEmitter } = await import('node:events');

  return {
    default: ({ auth }: { auth: MockSocket['auth'] }) => {
      const sock = {
        ev: new EventEmitter(),
        auth,
        user: { id: '5511999999999:1@s.whatsapp.net' },
        end: () => {},
        logout: async () => {},
        groupFetchAllParticipating: async () => ({}),
        updateMediaMessage: async () => {},
      };
      sockets.push(sock);
      return sock;
    },
    initAuthCreds: () => ({ registered: false }),
    BufferJSON: {
      replacer: (_key: string, value: unknown) => value,
      reviver: (_key: string, value: unknown) => {
        const buffer = value as { type?: string; data?: number[] } | null;
        return buffer?.type === 'Buffer' && Array.isArray(buffer.data) ? Buffer.from(buffer.data) : value;
      },
    },
    proto: { WebMessageInfo: proto.WebMessageInfo, Message: { AppStateSyncKeyData: { fromObject: (value: unknown) => value } } },
    DisconnectReason: { loggedOut: 401 },
    getContentType: (message: Record<string, unknown>) => Object.keys(message)[0],
    getDevice: () => 'android',
    jidNormalizedUser: (jid: string) => jid.replace(/:\d+(?=@)/, ''),
    downloadMediaMessage,
  };
});

function serviceWith(db = createTestDb(), logger = silentLogger()) {
  return { db, service: createInstanceService({ db, logger }) };
}

afterEach(() => {
  sockets.length = 0;
  downloadMediaMessage.mockClear();
});

describe('instance names', () => {
  it('accepts simple names', () => {
    expect(isValidName('personal')).toBe(true);
    expect(isValidName('sales-01_x')).toBe(true);
  });

  it('rejects unsafe names', () => {
    expect(isValidName('..')).toBe(false);
    expect(isValidName('a/b')).toBe(false);
    expect(isValidName('')).toBe(false);
    expect(isValidName(undefined)).toBe(false);
    expect(isValidName('x'.repeat(33))).toBe(false);
  });

  it('starts empty', () => {
    expect(serviceWith().service.listInstances()).toEqual([]);
  });
});

describe('instance persistence', () => {
  it('records an instance so its id survives a restart', async () => {
    const { db, service } = serviceWith();
    const created = await service.createInstance('acme');

    expect(created.id).toBeTruthy();
    expect(await db.instanceRecord.findUnique({ where: { name: 'acme' } })).toMatchObject({
      id: created.id,
      connectionStatus: 'connecting',
    });

    const restarted = createInstanceService({ db, logger: silentLogger() });
    await restarted.restoreInstances();

    expect(restarted.listInstances().map((instance) => instance.id)).toEqual([created.id]);
  });

  it('persists credentials and signal keys in PostgreSQL', async () => {
    const { db, service } = serviceWith();
    await service.createInstance('acme');
    await saveAuthState();

    const restarted = createInstanceService({ db, logger: silentLogger() });
    await restarted.restoreInstances();
    const restored = socket().auth;
    if (!restored) throw new Error('restored socket has no auth state');
    await expect(restored.keys.get('session', ['peer'])).resolves.toEqual({ peer: Buffer.from('key') });
    expect(restored.creds.registered).toBe(false);
  });

  it('removes the record when the instance is deleted', async () => {
    const { db, service } = serviceWith();
    await service.createInstance('acme');
    await saveAuthState();
    await service.deleteInstance('acme');

    expect(await db.instanceRecord.count()).toBe(0);
    expect(await db.baileysAuthState.count()).toBe(0);
    // Deleting an unknown instance stays a no-op.
    await expect(service.deleteInstance('acme')).resolves.toBeUndefined();
  });

  it('does not create a second record for the same name', async () => {
    const { db, service } = serviceWith();
    const first = await service.createInstance('acme');
    const second = await service.createInstance('acme');

    expect(second.id).toBe(first.id);
    expect(await db.instanceRecord.count()).toBe(1);
  });

  it('rejects a concurrent API create while one is already pending', async () => {
    const { service } = serviceWith();
    const first = service.createInstance('acme', { failIfExists: true });
    const second = service.createInstance('acme', { failIfExists: true });

    await expect(second).rejects.toBeInstanceOf(InstanceAlreadyExistsError);
    await expect(first).resolves.toMatchObject({ name: 'acme' });
    expect(sockets).toHaveLength(1);
  });
});

describe('renaming an instance', () => {
  it('moves the record while keeping its database-backed pairing', async () => {
    const { db, service } = serviceWith();
    const { id } = await service.createInstance('acme');
    await saveAuthState();

    await service.renameInstance('acme', 'globex');

    expect(service.getInstance('acme')).toBeUndefined();
    // The id survives, so webhook settings and message history follow the rename.
    expect(service.getInstance('globex')).toMatchObject({ id, name: 'globex' });
    expect(await db.instanceRecord.findUnique({ where: { id } })).toMatchObject({ name: 'globex' });
    expect(await db.baileysAuthState.findUnique({ where: { instanceId: id } })).not.toBeNull();
  });

  it('notifies subscribers so the dashboard picks up the new name', async () => {
    const { service } = serviceWith();
    await service.createInstance('acme');

    const events: string[] = [];
    service.subscribe((event) => {
      if (event.type === 'updated') events.push(event.instance.name);
    });
    await service.renameInstance('acme', 'globex');

    expect(events).toContain('globex');
  });

  it('refuses a name another instance already holds', async () => {
    const { service } = serviceWith();
    await service.createInstance('acme');
    await service.createInstance('globex');

    await expect(service.renameInstance('acme', 'globex')).rejects.toThrow();
    expect(service.getInstance('acme')).toBeDefined();
  });

  it('maps a concurrent database name collision to a domain conflict', async () => {
    const { db, service } = serviceWith();
    await service.createInstance('acme');
    await service.createInstance('beta');
    const other = createInstanceService({ db, logger: silentLogger() });
    await other.restoreInstances();

    const results = await Promise.allSettled([
      service.renameInstance('acme', 'globex'),
      other.renameInstance('beta', 'globex'),
    ]);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');

    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toBeInstanceOf(InstanceNameTakenError);
  });

  it('rejects an invalid new name before touching anything', async () => {
    const { service } = serviceWith();
    await service.createInstance('acme');

    await expect(service.renameInstance('acme', '../escape')).rejects.toThrow('Invalid instance name');
    expect(service.getInstance('acme')).toBeDefined();
  });

  it('leaves a disconnected instance disconnected', async () => {
    const { service } = serviceWith();
    await service.createInstance('acme');
    await service.disconnectInstance('acme');

    await service.renameInstance('acme', 'globex');

    expect(service.getInstance('globex')).toMatchObject({ status: 'close' });
  });

  it('ignores a rename to the same name and an unknown instance', async () => {
    const { service } = serviceWith();
    await service.createInstance('acme');

    await expect(service.renameInstance('acme', 'acme')).resolves.toBeUndefined();
    await expect(service.renameInstance('nobody', 'globex')).resolves.toBeUndefined();
    expect(service.getInstance('acme')).toBeDefined();
  });
});

describe('reconnecting after a logout', () => {
  // 401 matches the mocked DisconnectReason.loggedOut above.
  const loggedOutClose = { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } };

  it('flags a loggedOut close and skips the auto-reconnect', async () => {
    const { service } = serviceWith();
    await service.createInstance('acme');
    const openSockets = sockets.length;

    socket().ev.emit('connection.update', loggedOutClose);

    expect(sockets).toHaveLength(openSockets);
    expect(service.getInstance('acme')).toMatchObject({ status: 'close', loggedOut: true });
  });

  it('wipes the auth state on reconnect so a re-scan gets a fresh QR', async () => {
    const { db, service } = serviceWith();
    const instance = await service.createInstance('acme');
    await saveAuthState();
    socket().ev.emit('connection.update', loggedOutClose);
    const stale = socket();

    await service.reconnectInstance('acme');

    expect(await db.baileysAuthState.findUnique({ where: { instanceId: instance.id } })).toBeNull();
    expect(socket()).not.toBe(stale);
    expect(service.getInstance('acme')).toMatchObject({ loggedOut: false });
  });

  it('leaves auth state alone for a voluntary disconnect', async () => {
    const { db, service } = serviceWith();
    const instance = await service.createInstance('acme');
    await saveAuthState();

    await service.disconnectInstance('acme');
    await service.reconnectInstance('acme');

    expect(await db.baileysAuthState.findUnique({ where: { instanceId: instance.id } })).not.toBeNull();
  });

  it('clears a cached QR before a voluntary reconnect', async () => {
    const { service } = serviceWith();
    await service.createInstance('acme');
    socket().ev.emit('connection.update', { qr: '2@expired' });
    await sleep(50);

    await service.disconnectInstance('acme');
    await service.reconnectInstance('acme');

    expect(service.getInstance('acme')).toMatchObject({ status: 'connecting', qr: undefined, qrDataUrl: undefined });
  });

  it('coalesces simultaneous reconnects into one replacement socket', async () => {
    const { service } = serviceWith();
    await service.createInstance('acme');
    await service.disconnectInstance('acme');

    await Promise.all([service.reconnectInstance('acme'), service.reconnectInstance('acme')]);

    expect(sockets).toHaveLength(2);
  });

  it('wipes auth state after an explicit logout', async () => {
    const { db, service } = serviceWith();
    const instance = await service.createInstance('acme');
    await saveAuthState();

    await service.logoutInstance('acme');

    expect(service.getInstance('acme')).toMatchObject({ status: 'close', loggedOut: true });
    expect(await db.baileysAuthState.findUnique({ where: { instanceId: instance.id } })).toBeNull();

    await service.reconnectInstance('acme');

    expect(service.getInstance('acme')).toMatchObject({ loggedOut: false });
  });
});

describe('qr encoding', () => {
  it('caches the qr as a png data url once it is ready', async () => {
    const { service } = serviceWith();
    await service.createInstance('acme');

    socket().ev.emit('connection.update', { qr: '2@abcdef1234567890' });
    // The encode runs off-band (zlib deflate is threadpool-async); give it a moment.
    await sleep(50);

    expect(service.getInstance('acme')).toMatchObject({ status: 'qr', qr: '2@abcdef1234567890' });
    expect(service.getInstance('acme')?.qrDataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('does not restore a QR after the socket opens while it encodes', async () => {
    const { service } = serviceWith();
    await service.createInstance('acme');

    socket().ev.emit('connection.update', { qr: '2@already-scanned' });
    socket().ev.emit('connection.update', { connection: 'open' });
    await sleep(50);

    expect(service.getInstance('acme')).toMatchObject({ status: 'open', qr: undefined, qrDataUrl: undefined });
  });
});

describe('toRecipientJid', () => {
  it('qualifies a bare number and tolerates formatting', () => {
    expect(toRecipientJid('5511888888888')).toBe('5511888888888@s.whatsapp.net');
    expect(toRecipientJid(' +55 11 99999 0001 ')).toBe('5511999990001@s.whatsapp.net');
  });

  it('passes an already-qualified jid through, groups included', () => {
    expect(toRecipientJid('5511888888888@s.whatsapp.net')).toBe('5511888888888@s.whatsapp.net');
    expect(toRecipientJid('5511999990005-1700000001@g.us')).toBe('5511999990005-1700000001@g.us');
  });

  it('yields nothing for a number with no digits', () => {
    expect(toRecipientJid('   ')).toBe('');
    expect(toRecipientJid('abc')).toBe('');
  });

  it('yields nothing for a jid with no local part', () => {
    expect(toRecipientJid('@')).toBe('');
    expect(toRecipientJid('@s.whatsapp.net')).toBe('');
  });
});

describe('sending a text message', () => {
  async function connected() {
    const { service } = serviceWith();
    await service.createInstance('acme');
    // The mocked socket never reports a connection, so open it by hand.
    socket().ev.emit('connection.update', { connection: 'open' });
    return service;
  }

  it('sends through the socket and returns the normalized message', async () => {
    const service = await connected();
    const sent: unknown[] = [];
    Object.assign(socket(), {
      sendMessage: (jid: string, content: unknown) => {
        sent.push([jid, content]);
        return {
          key: { remoteJid: jid, fromMe: true, id: 'SENT-1' },
          message: { conversation: 'hola' },
          messageTimestamp: 1756555200,
          status: 1,
        };
      },
    });

    const events: InstanceEvent[] = [];
    service.subscribe((event) => {
      if (event.type === 'sent') events.push(event);
    });

    const message = await service.sendText('acme', '+55 11 888888888', 'hola');

    expect(sent).toEqual([['5511888888888@s.whatsapp.net', { text: 'hola' }]]);
    // Subscribers hear about the send, which is what becomes SEND_MESSAGE.
    expect(events).toEqual([{ type: 'sent', instance: expect.objectContaining({ name: 'acme' }), message }]);
    expect(message).toMatchObject({
      key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: true, id: 'SENT-1' },
      message: { conversation: 'hola' },
      messageType: 'conversation',
      status: 'PENDING',
    });
  });

  it('simulates typing for the delay: presence chunked at 20 s, then paused, then sends', async () => {
    const service = await connected();
    const presence: [string, string][] = [];
    let sent = false;
    Object.assign(socket(), {
      presenceSubscribe: async () => {},
      sendPresenceUpdate: async (type: string, jid: string) => {
        presence.push([type, jid]);
      },
      sendMessage: async () => {
        sent = true;
        return {
          key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: true, id: 'SENT-1' },
          message: { conversation: 'hola' },
          messageTimestamp: 1756555200,
          status: 1,
        };
      },
    });

    vi.useFakeTimers();
    try {
      const pending = service.sendText('acme', '+55 11 888888888', 'hola', { delay: 30000, presence: 'recording' });
      await vi.advanceTimersByTimeAsync(20000);
      // The second chunk is already composing; only its sleep is pending.
      expect(presence).toEqual([
        ['recording', '5511888888888@s.whatsapp.net'],
        ['paused', '5511888888888@s.whatsapp.net'],
        ['recording', '5511888888888@s.whatsapp.net'],
      ]);
      expect(sent).toBe(false);

      await vi.advanceTimersByTimeAsync(10000);
      expect(presence).toEqual([
        ['recording', '5511888888888@s.whatsapp.net'],
        ['paused', '5511888888888@s.whatsapp.net'],
        ['recording', '5511888888888@s.whatsapp.net'],
        ['paused', '5511888888888@s.whatsapp.net'],
      ]);
      expect(sent).toBe(true);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it('edits an outbound message and emits SEND_MESSAGE_UPDATE source data', async () => {
    const service = await connected();
    const sent: unknown[] = [];
    Object.assign(socket(), {
      sendMessage: (jid: string, content: unknown) => {
        sent.push([jid, content]);
        return {
          key: { remoteJid: jid, fromMe: true, id: 'EDIT-OUT-1' },
          message: {
            protocolMessage: {
              key: { remoteJid: jid, fromMe: true, id: 'SENT-1' },
              editedMessage: { conversation: 'corregido' },
              type: 'MESSAGE_EDIT',
            },
          },
          messageTimestamp: 1756555300,
        };
      },
    });
    const events: InstanceEvent[] = [];
    service.subscribe((event) => {
      events.push(event);
    });

    const response = await service.editMessage('acme', {
      number: '5511888888888',
      text: 'corregido',
      key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: true, id: 'SENT-1' },
    });

    expect(sent).toEqual([[
      '5511888888888@s.whatsapp.net',
      { text: 'corregido', edit: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: true, id: 'SENT-1' } },
    ]]);
    expect(response).toMatchObject({ key: { id: 'EDIT-OUT-1' } });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'sent-message-update',
        message: expect.objectContaining({
          key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: true, id: 'SENT-1' },
          data: expect.objectContaining({ type: 'MESSAGE_EDIT' }),
        }),
      }),
    ]);
  });

  it('refuses to edit another sender message or a mismatched chat', async () => {
    const service = await connected();
    const input = {
      number: '5511888888888',
      text: 'corregido',
      key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: true, id: 'SENT-1' },
    };

    await expect(service.editMessage('acme', { ...input, key: { ...input.key, fromMe: false } })).rejects.toThrow(
      'only edit messages you sent',
    );
    await expect(service.editMessage('acme', { ...input, key: { ...input.key, remoteJid: 'other@s.whatsapp.net' } })).rejects.toThrow(
      'RemoteJid does not match',
    );
  });

  it('refuses to send through an instance that is not connected', async () => {
    const { service } = serviceWith();
    await service.createInstance('acme');

    await expect(service.sendText('acme', '5511888888888', 'hola')).rejects.toThrow('is not connected');
  });

  it('refuses an unknown instance and an unusable number', async () => {
    const service = await connected();

    await expect(service.sendText('ghost', '5511888888888', 'hola')).rejects.toThrow('does not exist');
    await expect(service.sendText('acme', 'abc', 'hola')).rejects.toThrow('Invalid recipient number');
  });
});

describe('sending media', () => {
  async function connected() {
    const { service } = serviceWith();
    await service.createInstance('acme');
    // The mocked socket never reports a connection, so open it by hand.
    socket().ev.emit('connection.update', { connection: 'open' });
    return service;
  }

  const base64Png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  it('decodes base64 media and sends it through the socket', async () => {
    const service = await connected();
    const sent: unknown[] = [];
    Object.assign(socket(), {
      sendMessage: (jid: string, content: unknown) => {
        sent.push([jid, content]);
        return {
          key: { remoteJid: jid, fromMe: true, id: 'SENT-MEDIA-1' },
          message: { imageMessage: {} },
          messageTimestamp: 1756555200,
          status: 1,
        };
      },
    });

    const message = await service.sendMedia('acme', '5511888888888', 'image', base64Png, 'image/png', { caption: 'hola' });

    expect(sent).toEqual([[
      '5511888888888@s.whatsapp.net',
      { image: Buffer.from(base64Png, 'base64'), mimetype: 'image/png', caption: 'hola' },
    ]]);
    expect(fetchRemoteMedia).not.toHaveBeenCalled();
    expect(message).toMatchObject({ key: { id: 'SENT-MEDIA-1' } });
  });

  it('fetches media from a url before sending', async () => {
    const service = await connected();
    vi.mocked(fetchRemoteMedia).mockResolvedValueOnce({ buffer: Buffer.from('fetched-bytes') });
    const sent: unknown[] = [];
    Object.assign(socket(), {
      sendMessage: (jid: string, content: unknown) => {
        sent.push([jid, content]);
        return {
          key: { remoteJid: jid, fromMe: true, id: 'SENT-MEDIA-2' },
          message: { documentMessage: {} },
          messageTimestamp: 1756555200,
          status: 1,
        };
      },
    });

    await service.sendMedia('acme', '5511888888888', 'document', 'https://example.com/file.pdf', 'application/pdf', {
      fileName: 'file.pdf',
    });

    expect(fetchRemoteMedia).toHaveBeenCalledWith('https://example.com/file.pdf', expect.objectContaining({ maxBytes: expect.any(Number) }));
    expect(sent).toEqual([[
      '5511888888888@s.whatsapp.net',
      { document: Buffer.from('fetched-bytes'), mimetype: 'application/pdf', fileName: 'file.pdf' },
    ]]);
  });

  it('infers the mimetype and document name from the url when the caller omits them', async () => {
    const service = await connected();
    vi.mocked(fetchRemoteMedia).mockResolvedValueOnce({ buffer: Buffer.from('fetched-bytes') });
    const sent: unknown[] = [];
    Object.assign(socket(), {
      sendMessage: (jid: string, content: unknown) => {
        sent.push(content);
        return { key: { remoteJid: jid, fromMe: true, id: 'SENT-MEDIA-3' }, message: { documentMessage: {} }, messageTimestamp: 1756555200, status: 1 };
      },
    });

    const message = await service.sendMedia('acme', '5511888888888', 'document', 'https://example.com/docs/informe%20final.pdf', undefined);

    expect(sent).toEqual([{ document: Buffer.from('fetched-bytes'), mimetype: 'application/pdf', fileName: 'informe final.pdf' }]);
    // What is stored and served back is the inferred type, not whatever the caller sent.
    expect(message.media).toEqual({ buffer: Buffer.from('fetched-bytes'), mimetype: 'application/pdf' });
  });

  it('names an extensionless url document from its resolved mimetype, and names one sent with an explicit mimetype', async () => {
    const service = await connected();
    const sent: { mimetype?: string; fileName?: string }[] = [];
    Object.assign(socket(), {
      sendMessage: (jid: string, content: { mimetype?: string; fileName?: string }) => {
        sent.push(content);
        return { key: { remoteJid: jid, fromMe: true, id: 'SENT-MEDIA-7' }, message: { documentMessage: {} }, messageTimestamp: 1756555200, status: 1 };
      },
    });
    vi.mocked(fetchRemoteMedia)
      .mockResolvedValueOnce({ buffer: Buffer.from('x'), contentType: 'application/pdf' })
      .mockResolvedValueOnce({ buffer: Buffer.from('x') });

    await service.sendMedia('acme', '5511888888888', 'document', 'https://example.com/download', undefined);
    await service.sendMedia('acme', '5511888888888', 'document', 'https://example.com/reports/q3.docx', 'application/vnd.custom');

    expect(sent.map(({ mimetype, fileName }) => ({ mimetype, fileName }))).toEqual([
      { mimetype: 'application/pdf', fileName: 'download.pdf' },
      { mimetype: 'application/vnd.custom', fileName: 'q3.docx' },
    ]);
  });

  it('falls back to the response content-type, then to the payload bytes', async () => {
    const service = await connected();
    const sent: { mimetype?: string }[] = [];
    Object.assign(socket(), {
      sendMessage: (jid: string, content: { mimetype?: string }) => {
        sent.push(content);
        return { key: { remoteJid: jid, fromMe: true, id: 'SENT-MEDIA-4' }, message: { imageMessage: {} }, messageTimestamp: 1756555200, status: 1 };
      },
    });
    vi.mocked(fetchRemoteMedia).mockResolvedValueOnce({ buffer: Buffer.from('x'), contentType: 'image/webp; charset=binary' });

    await service.sendMedia('acme', '5511888888888', 'image', 'https://example.com/download?id=1', undefined);
    await service.sendMedia('acme', '5511888888888', 'image', base64Png, undefined);

    expect(sent.map((content) => content.mimetype)).toEqual(['image/webp', 'image/png']);
  });

  it('prefers the caller fileName over the url-derived one, and keeps the extension of a long url name', async () => {
    const service = await connected();
    const sent: { mimetype?: string; fileName?: string }[] = [];
    Object.assign(socket(), {
      sendMessage: (jid: string, content: { mimetype?: string; fileName?: string }) => {
        sent.push(content);
        return { key: { remoteJid: jid, fromMe: true, id: 'SENT-MEDIA-6' }, message: { documentMessage: {} }, messageTimestamp: 1756555200, status: 1 };
      },
    });
    vi.mocked(fetchRemoteMedia)
      .mockResolvedValueOnce({ buffer: Buffer.from('fetched-bytes') })
      .mockResolvedValueOnce({ buffer: Buffer.from('fetched-bytes') });

    await service.sendMedia('acme', '5511888888888', 'document', 'https://example.com/file.pdf', undefined, { fileName: 'mio.pdf' });
    await service.sendMedia('acme', '5511888888888', 'document', `https://example.com/${'a'.repeat(300)}.pdf`, undefined);

    expect(sent[0]).toMatchObject({ mimetype: 'application/pdf', fileName: 'mio.pdf' });
    expect(sent[1]?.mimetype).toBe('application/pdf');
    expect(sent[1]?.fileName).toHaveLength(255);
    expect(sent[1]?.fileName?.endsWith('.pdf')).toBe(true);
  });

  it('still infers from the url when the media value has leading whitespace', async () => {
    const service = await connected();
    vi.mocked(fetchRemoteMedia).mockResolvedValueOnce({ buffer: Buffer.from('fetched-bytes') });
    const sent: unknown[] = [];
    Object.assign(socket(), {
      sendMessage: (jid: string, content: unknown) => {
        sent.push(content);
        return { key: { remoteJid: jid, fromMe: true, id: 'SENT-MEDIA-5' }, message: { documentMessage: {} }, messageTimestamp: 1756555200, status: 1 };
      },
    });

    await service.sendMedia('acme', '5511888888888', 'document', ' https://example.com/file.pdf', undefined);

    expect(sent).toEqual([{ document: Buffer.from('fetched-bytes'), mimetype: 'application/pdf', fileName: 'file.pdf' }]);
  });

  it('ignores a response content-type that does not fit the media kind', async () => {
    const service = await connected();
    vi.mocked(fetchRemoteMedia).mockResolvedValueOnce({ buffer: Buffer.from('<html>'), contentType: 'text/html' });
    let called = false;
    Object.assign(socket(), { sendMessage: () => { called = true; } });

    await expect(
      service.sendMedia('acme', '5511888888888', 'image', 'https://example.com/download?id=1', undefined),
    ).rejects.toThrow('"mimetype" could not be inferred');
    expect(called).toBe(false);
  });

  it('rejects media whose mimetype cannot be inferred without reaching the socket', async () => {
    const service = await connected();
    let called = false;
    Object.assign(socket(), { sendMessage: () => { called = true; } });

    await expect(
      service.sendMedia('acme', '5511888888888', 'document', Buffer.from('plain text').toString('base64'), undefined),
    ).rejects.toThrow('"mimetype" could not be inferred');
    expect(called).toBe(false);
  });

  it('rejects media over the size cap without reaching the socket', async () => {
    const service = await connected();
    vi.mocked(fetchRemoteMedia).mockResolvedValueOnce({ buffer: Buffer.alloc(21 * 1024 * 1024) });
    let called = false;
    Object.assign(socket(), { sendMessage: () => { called = true; } });

    await expect(
      service.sendMedia('acme', '5511888888888', 'image', 'https://example.com/huge.png', 'image/png'),
    ).rejects.toThrow('exceeds');
    expect(called).toBe(false);
  });

  it('rejects unsupported URLs and malformed base64 without reaching the socket', async () => {
    const service = await connected();
    let called = false;
    Object.assign(socket(), { sendMessage: () => { called = true; } });

    await expect(
      service.sendMedia('acme', '5511888888888', 'image', 'file:///etc/passwd', 'image/png'),
    ).rejects.toThrow('URL must use http or https');
    await expect(
      service.sendMedia('acme', '5511888888888', 'image', 'not base64!', 'image/png'),
    ).rejects.toThrow('valid base64');
    await expect(
      service.sendAudio('acme', '5511888888888', 'not base64!', { encoding: false }),
    ).rejects.toThrow('"audio" must be an http(s) URL or valid base64');
    expect(called).toBe(false);
  });

  it('refuses to send through an instance that is not connected', async () => {
    const { service } = serviceWith();
    await service.createInstance('acme');

    await expect(service.sendMedia('acme', '5511888888888', 'image', base64Png, 'image/png')).rejects.toThrow('is not connected');
  });

  it('refuses an unknown instance and an unusable number', async () => {
    const service = await connected();

    await expect(service.sendMedia('ghost', '5511888888888', 'image', base64Png, 'image/png')).rejects.toThrow('does not exist');
    await expect(service.sendMedia('acme', 'abc', 'image', base64Png, 'image/png')).rejects.toThrow('Invalid recipient number');
  });
});

describe('send context fields', () => {
  async function connected() {
    const { db, service } = serviceWith();
    const instance = await service.createInstance('acme');
    socket().ev.emit('connection.update', { connection: 'open' });

    const calls: { jid: string; content: Record<string, unknown>; options?: Record<string, unknown> }[] = [];
    Object.assign(socket(), {
      sendMessage: (jid: string, content: Record<string, unknown>, options?: Record<string, unknown>) => {
        calls.push({ jid, content, options });
        return {
          key: { remoteJid: jid, fromMe: true, id: 'SENT-1' },
          message: { conversation: 'hola' },
          messageTimestamp: 1756555200,
          status: 1,
        };
      },
      groupMetadata: async () => ({
        participants: [{ id: '5511111111111@s.whatsapp.net' }, { id: '5522222222222@s.whatsapp.net' }],
      }),
    });

    return { db, service, instance, calls };
  }

  it('recovers the matching quoted message from storage when only its key came in', async () => {
    const { db, service, instance, calls } = await connected();
    await db.message.create({
      data: {
        instanceId: instance.id,
        keyId: 'STORED-1',
        remoteJid: '5511777777777@s.whatsapp.net',
        fromMe: false,
        messageType: 'conversation',
        messageTimestamp: 1756555100,
        content: { conversation: 'the wrong message' },
      },
    });
    await db.message.create({
      data: {
        instanceId: instance.id,
        keyId: 'STORED-1',
        remoteJid: '5511888888888@s.whatsapp.net',
        fromMe: false,
        messageType: 'conversation',
        messageTimestamp: 1756555100,
        content: { conversation: 'the one being replied to' },
      },
    });

    await service.sendText('acme', '5511888888888', 'hola', {
      quoted: { key: { id: 'STORED-1', remoteJid: '5511888888888@s.whatsapp.net', fromMe: false } },
    });

    expect(calls[0]?.options).toEqual({
      quoted: {
        key: { id: 'STORED-1', remoteJid: '5511888888888@s.whatsapp.net', fromMe: false },
        message: { conversation: 'the one being replied to' },
      },
    });
  });

  it('mentions every participant of a group', async () => {
    const { service, calls } = await connected();

    await service.sendText('acme', '123456@g.us', 'hola', { mentionsEveryOne: true });

    expect(calls[0]?.content.mentions).toEqual(['5511111111111@s.whatsapp.net', '5522222222222@s.whatsapp.net']);
  });

  it('resolves listed mentions to JIDs, and ignores them outside a group', async () => {
    const { service, calls } = await connected();

    await service.sendText('acme', '123456@g.us', 'hola', { mentioned: ['5511111111111'] });
    await service.sendText('acme', '5511888888888', 'hola', { mentioned: ['5511111111111'] });

    expect(calls[0]?.content.mentions).toEqual(['5511111111111@s.whatsapp.net']);
    // A one-to-one chat has nobody to mention; the reference skips them there too.
    expect(calls[1]?.content.mentions).toBeUndefined();
  });

});

describe('group names from the socket', () => {
  async function watching() {
    const { service } = serviceWith();
    await service.createInstance('acme');
    const events: InstanceEvent[] = [];
    service.subscribe((event) => {
      if (event.type === 'groups') events.push(event);
    });
    return { service, events };
  }

  it('fetches group metadata after connecting', async () => {
    const { events } = await watching();
    const fetch = vi.fn(async () => {
      socket().ev.emit('groups.update', [{ id: '1-2@g.us', subject: 'Book Club' }]);
      return {};
    });
    socket().groupFetchAllParticipating = fetch;

    socket().ev.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    expect(events).toEqual([
      { type: 'groups', instance: expect.objectContaining({ name: 'acme' }), groups: [{ id: '1-2@g.us', subject: 'Book Club' }] },
    ]);
  });

  it.each(['groups.upsert', 'groups.update'] as const)('emits the subject from %s', async (event) => {
    const { events } = await watching();

    socket().ev.emit(event, [{ id: '1-2@g.us', subject: '  Book Club  ' }]);

    expect(events).toEqual([
      { type: 'groups', instance: expect.objectContaining({ name: 'acme' }), groups: [{ id: '1-2@g.us', subject: 'Book Club' }] },
    ]);
  });

  // An update carries only what changed, so most of them say nothing about the name.
  it('emits nothing for an update that does not touch the subject', async () => {
    const { events } = await watching();

    socket().ev.emit('groups.update', [{ id: '1-2@g.us', announce: true }, { id: '3-4@g.us', subject: '   ' }]);

    expect(events).toHaveLength(0);
  });
});

describe('contact names from the socket', () => {
  async function watching() {
    const { service } = serviceWith();
    await service.createInstance('acme');
    const events: InstanceEvent[] = [];
    service.subscribe((event) => {
      if (event.type === 'contacts') events.push(event);
    });
    return { events };
  }

  it.each(['contacts.upsert', 'contacts.update'] as const)('emits a contact name from %s', async (event) => {
    const { events } = await watching();

    socket().ev.emit(event, [{ id: '5511888888888@s.whatsapp.net', name: '  Jane  ' }]);

    expect(events).toEqual([
      {
        type: 'contacts',
        instance: expect.objectContaining({ name: 'acme' }),
        contacts: [{ id: '5511888888888@s.whatsapp.net', name: 'Jane' }],
      },
    ]);
  });

  it('uses a verified name when no local name exists and ignores unusable contacts', async () => {
    const { events } = await watching();

    socket().ev.emit('contacts.upsert', [
      { id: '5511888888888@s.whatsapp.net', verifiedName: 'Jane Verified' },
      { id: 'lid@lid', phoneNumber: '5511777777777@s.whatsapp.net', notify: 'Jane Profile' },
      { id: '123@g.us', name: 'Not a contact' },
      { id: '5511999999999@s.whatsapp.net', name: '   ' },
    ]);

    expect(events[0]).toMatchObject({
      contacts: [
        { id: '5511888888888@s.whatsapp.net', name: 'Jane Verified' },
        { id: '5511777777777@s.whatsapp.net', name: 'Jane Profile' },
      ],
    });
  });
});

describe('history sync from the socket', () => {
  it('forwards late LID mappings as internal events, not connection webhooks', async () => {
    const { service } = serviceWith();
    await service.createInstance('acme');
    const events: InstanceEvent[] = [];
    service.subscribe((event) => {
      if (event.type === 'chat-alias') events.push(event);
    });
    socket().ev.emit('lid-mapping.update', { lid: '100000000000002@lid', pn: '5511888888888@s.whatsapp.net' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ alias: { lid: '100000000000002@lid', pn: '5511888888888@s.whatsapp.net' } });
    expect(toDomainEvents(events[0])).toEqual([]);
  });

  const history = {
    chats: [],
    contacts: [{ id: '5511888888888@s.whatsapp.net', name: 'Jane' }],
    messages: [
      {
        key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: false, id: 'HIST-1' },
        message: { conversation: 'old hello' },
        messageTimestamp: 1756555000,
      },
    ],
    isLatest: true,
  } as never;

  it('emits one history event with mapped messages and contact names when syncFullHistory is on', async () => {
    const { db, service } = serviceWith();
    const instance = await service.createInstance('acme');
    await db.instanceSettings.create({ data: { instanceId: instance.id, syncFullHistory: true } });
    const events: InstanceEvent[] = [];
    service.subscribe((event) => {
      if (event.type === 'history') events.push(event);
    });

    socket().ev.emit('messaging-history.set', history);
    await vi.waitFor(() => expect(events).toHaveLength(1));

    expect(events[0]).toMatchObject({
      type: 'history',
      contacts: [{ id: '5511888888888@s.whatsapp.net', name: 'Jane' }],
      messages: [{ key: { id: 'HIST-1' }, messageType: 'conversation' }],
    });
    expect(events[0]).not.toHaveProperty('messages.0.media');
  });

  it('imports history after a transient settings read failure', async () => {
    const db = createTestDb();
    const settings = db.instanceSettings;
    const read = vi.fn(settings.findUnique.bind(settings)).mockRejectedValueOnce(new Error('temporary outage'));
    const failingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'instanceSettings') return { ...settings, findUnique: read };
        return Reflect.get(target, property, receiver);
      },
    });
    const { service } = serviceWith(failingDb);
    const instance = await service.createInstance('acme');
    await db.instanceSettings.create({ data: { instanceId: instance.id, syncFullHistory: true } });
    const events: InstanceEvent[] = [];
    service.subscribe((event) => {
      if (event.type === 'history') events.push(event);
    });

    socket().ev.emit('messaging-history.set', history);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ messages: [{ key: { id: 'HIST-1' } }] });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('ignores history by default', async () => {
    const { service } = serviceWith();
    await service.createInstance('acme');
    const events: InstanceEvent[] = [];
    service.subscribe((event) => {
      if (event.type === 'history') events.push(event);
    });

    socket().ev.emit('messaging-history.set', history);
    await sleep(100);

    expect(events).toEqual([]);
  });
});

describe('on-demand message media', () => {
  it('restores base64 media keys and downloads through the connected socket with reupload support', async () => {
    const { service } = serviceWith();
    await service.createInstance('acme');
    const mediaKey = Buffer.alloc(32, 7);
    const message = { key: { id: 'HISTORY-AUDIO', remoteJid: '5511888888888@s.whatsapp.net', fromMe: true },
      message: { audioMessage: { mediaKey: mediaKey.toString('base64'), directPath: '/history-audio', mimetype: 'audio/ogg; codecs=opus' } },
      messageType: 'audioMessage',
    };
    expect(await service.downloadMessageMedia('acme', message)).toBeUndefined();
    expect(downloadMediaMessage).not.toHaveBeenCalled();
    socket().ev.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(service.getInstance('acme')?.status).toBe('open'));
    const result = await service.downloadMessageMedia('acme', message);
    expect(result).toEqual({ buffer: Buffer.from('media-bytes'), mimetype: 'audio/ogg; codecs=opus' });
    const raw = (downloadMediaMessage.mock.calls as unknown as [import('baileys').WAMessage][])[0][0];
    expect(Buffer.from(raw.message!.audioMessage!.mediaKey!)).toEqual(mediaKey);
    expect(downloadMediaMessage).toHaveBeenCalledWith(expect.anything(), 'stream',
      expect.anything(), expect.objectContaining({ reuploadRequest: socket().updateMediaMessage }));
    downloadMediaMessage.mockResolvedValueOnce(Readable.from([Buffer.alloc(MAX_OUTBOUND_MEDIA_BYTES + 1)]));
    expect(await service.downloadMessageMedia('acme', message)).toBeUndefined();
  });
});

describe('inbound messages from the socket', () => {
  const upsert = (overrides: Record<string, unknown> = {}) => ({
    type: 'notify',
    messages: [
      {
        key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: false, id: 'ABC' },
        message: { conversation: 'hello there' },
        messageTimestamp: 1756555200,
      },
    ],
    ...overrides,
  });

  async function watching() {
    const { service } = serviceWith();
    await service.createInstance('acme');
    const events: InstanceEvent[] = [];
    service.subscribe((event) => {
      if (event.type === 'messages') events.push(event);
    });
    return { service, events };
  }

  it('emits normalized messages, never raw Baileys objects', async () => {
    const { events } = await watching();

    socket().ev.emit('messages.upsert', upsert());

    expect(events).toHaveLength(1);
    const [event] = events as [Extract<InstanceEvent, { type: 'messages' }>];
    expect(event.instance.name).toBe('acme');
    expect(event.messages).toEqual([
      {
        key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: false, id: 'ABC' },
        message: { conversation: 'hello there' },
        messageType: 'conversation',
        messageTimestamp: 1756555200,
        // Generated per instance, so match the event's own id rather than a literal.
        instanceId: event.instance.id,
        source: 'android',
        status: 'DELIVERY_ACK',
      },
    ]);
  });

  it('uses the socket reupload callback to fetch sticker media', async () => {
    const { events } = await watching();

    socket().ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: false, id: 'STICKER-1' },
          message: { stickerMessage: { mimetype: 'image/webp' } },
          messageTimestamp: 1756555200,
        },
      ],
    });

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(downloadMediaMessage).toHaveBeenCalledWith(
      expect.objectContaining({ key: expect.objectContaining({ id: 'STICKER-1' }) }),
      'stream',
      {},
      expect.objectContaining({ reuploadRequest: socket().updateMediaMessage }),
    );
    expect(events[0]).toMatchObject({ messages: [{ media: { buffer: Buffer.from('media-bytes'), mimetype: 'image/webp' } }] });
  });

  it('does not buffer inbound media over the outbound media limit', async () => {
    const { events } = await watching();
    downloadMediaMessage.mockResolvedValueOnce(Readable.from([Buffer.alloc(MAX_OUTBOUND_MEDIA_BYTES + 1)]));

    socket().ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: false, id: 'TOO-LARGE' },
          message: { stickerMessage: { mimetype: 'image/webp' } },
          messageTimestamp: 1756555200,
        },
      ],
    });

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ messages: [{ key: { id: 'TOO-LARGE' } }] });
    expect(events[0].type === 'messages' && events[0].messages[0]).not.toHaveProperty('media');
  });

  it('logs only upsert metadata, never its message body', async () => {
    const logger = silentLogger();
    const debug = vi.spyOn(logger, 'debug');
    const { service } = serviceWith(createTestDb(), logger);
    await service.createInstance('acme');

    socket().ev.emit('messages.upsert', upsert());

    expect(debug).toHaveBeenCalledWith(
      { instance: 'acme', type: 'notify', count: 1 },
      'baileys messages.upsert',
    );
  });

  it('emits protocol edits separately from messages.upsert', async () => {
    const { service } = serviceWith();
    await service.createInstance('acme');
    const events: InstanceEvent[] = [];
    service.subscribe((event) => {
      events.push(event);
    });

    socket().ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: false, id: 'EDIT-1' },
          message: {
            protocolMessage: {
              key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: false, id: 'ORIGINAL-1' },
              editedMessage: { conversation: 'corregido' },
              type: 'MESSAGE_EDIT',
            },
          },
          messageTimestamp: 1756555300,
        },
      ],
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'message-edited',
        message: expect.objectContaining({
          key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: false, id: 'ORIGINAL-1' },
          data: expect.objectContaining({ type: 'MESSAGE_EDIT' }),
        }),
      }),
    ]);
  });

  it('ignores upsert types that are not real messages', async () => {
    const { events } = await watching();

    socket().ev.emit('messages.upsert', upsert({ type: 'prepend' }));

    expect(events).toHaveLength(0);
  });

  it('drops messages it cannot normalize without losing the batch', async () => {
    const { events } = await watching();

    socket().ev.emit('messages.upsert', {
      type: 'notify',
      messages: [{ key: { remoteJid: 'x@s.whatsapp.net', id: 'NOPE' } }, ...upsert().messages],
    });

    const [event] = events as [Extract<InstanceEvent, { type: 'messages' }>];
    expect(event.messages).toHaveLength(1);
    expect(event.messages[0].key.id).toBe('ABC');
  });

  it('never emits a protocol event as a message', async () => {
    const { events } = await watching();

    socket().ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: false, id: 'PROTO' },
          message: { protocolMessage: { type: 'REVOKE' } },
        },
      ],
    });

    expect(events).toHaveLength(0);
  });

  it('emits receipt updates and revokes from messages.update', async () => {
    const { service } = serviceWith();
    await service.createInstance('acme');
    const events: InstanceEvent[] = [];
    service.subscribe((event) => {
      events.push(event);
    });

    socket().ev.emit('messages.update', updates);

    expect(events).toEqual([
      {
        type: 'message-updated',
        instance: expect.objectContaining({ name: 'acme' }),
        update: {
          key: {
            remoteJid: '5511888888888@s.whatsapp.net',
            fromMe: false,
            id: '3EB0C767D26B8A3F1A2B0000000000AB',
          },
          status: 'READ',
        },
      },
      {
        type: 'message-deleted',
        instance: expect.objectContaining({ name: 'acme' }),
        key: {
          remoteJid: '5511888888888@s.whatsapp.net',
          fromMe: false,
          id: '3EB0C767D26B8A3F1A2B0000000000AC',
        },
      },
    ]);
  });

  it('does not emit an edit for the messages.update content shape', async () => {
    const { service } = serviceWith();
    await service.createInstance('acme');
    const events: InstanceEvent[] = [];
    service.subscribe((event) => {
      events.push(event);
    });

    socket().ev.emit('messages.update', [
      {
        key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: false, id: 'ORIGINAL-1' },
        update: { message: { editedMessage: { message: { conversation: 'corregido' } } } },
      },
    ]);

    expect(events).toHaveLength(0);
  });

  it('emits deletes from Baileys messages.delete too', async () => {
    const { service } = serviceWith();
    await service.createInstance('acme');
    const events: InstanceEvent[] = [];
    service.subscribe((event) => {
      events.push(event);
    });

    socket().ev.emit('messages.delete', {
      keys: [{ remoteJid: '5511888888888:12@s.whatsapp.net', fromMe: false, id: 'DELETED-FROM-SYNC' }],
    });

    expect(events).toEqual([
      {
        type: 'message-deleted',
        instance: expect.objectContaining({ name: 'acme' }),
        key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: false, id: 'DELETED-FROM-SYNC' },
      },
    ]);
  });

  it('emits nothing when the whole batch is unusable', async () => {
    const { events } = await watching();

    socket().ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'NOPE' } }] });

    expect(events).toHaveLength(0);
  });

  it('ignores a socket the instance has already replaced', async () => {
    const { service, events } = await watching();
    const stale = socket();
    // Only a closed instance reconnects, and reconnecting opens a fresh socket.
    await service.disconnectInstance('acme');
    await service.reconnectInstance('acme');
    expect(socket()).not.toBe(stale);

    stale.ev.emit('messages.upsert', upsert());

    expect(events).toHaveLength(0);
  });
});
