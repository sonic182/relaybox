import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { ControlResponse, ControlService } from '../../src/api/control';
import { createRemoteClient, type RemoteClient } from '../../src/remote';
import { createFakeTarget, type FakeTarget } from '../fakeRemoteTarget';

const unusedControl: ControlService = { execute: async () => ({ status: 404, body: null }) };

/** A started client dialling a fresh fake target, plus the teardown both of them need. */
async function startClient(): Promise<{ target: FakeTarget; client: RemoteClient; close(): Promise<void> }> {
  const target = await createFakeTarget();
  const client = createRemoteClient({ target: { url: target.url, token: 'secret' }, logger: pino({ level: 'silent' }), control: unusedControl });
  client.start();

  return {
    target,
    client,
    close: async () => {
      await client.stop();
      await target.close();
    },
  };
}

describe('remote client', () => {
  it('sends the token as a bearer header on the upgrade', async () => {
    const { target, close } = await startClient();
    try {
      await expect(target.connection(1)).resolves.toBe('Bearer secret');
    } finally {
      await close();
    }
  });

  it('reconnects after the server drops the connection', async () => {
    const { target, close } = await startClient();
    try {
      await target.connection(1);
      target.sockets[0].close();

      // The first retry waits exactly RECONNECT_BASE_DELAY_MS: backoffMs has no jitter to add yet.
      await expect(target.connection(2)).resolves.toBe('Bearer secret');
    } finally {
      await close();
    }
  }, 10_000);

  it('reconnects when an open socket stops answering pings', async () => {
    const target = await createFakeTarget(false);
    const client = createRemoteClient({ target: { url: target.url, token: 'secret' }, logger: pino({ level: 'silent' }), control: unusedControl });
    try {
      client.start();
      await target.connection(1);
      const disconnected = once(target.sockets[0], 'close');

      await disconnected;
      await expect(target.connection(2)).resolves.toBe('Bearer secret');
    } finally {
      await client.stop();
      await target.close();
    }
  }, 50_000);

  it('stops without reconnecting', async () => {
    const { target, client, close } = await startClient();
    try {
      await target.connection(1);
      // stop() closes the socket itself; the point is that its 'close' schedules no retry.
      await client.stop();
      // Comfortably past the 1s base delay, so a scheduled retry would have landed by now
      // even on a loaded runner.
      await new Promise((resolve) => setTimeout(resolve, 2_500));

      expect(target.sockets).toHaveLength(1);
    } finally {
      await close();
    }
  }, 10_000);

  it('answers an active control operation and refuses new ones before closing the socket', async () => {
    const target = await createFakeTarget();
    let entered!: () => void;
    let finish!: (response: ControlResponse) => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<ControlResponse>((resolve) => { finish = resolve; });
    let executions = 0;
    const control: ControlService = { execute: () => { executions++; entered(); return pending; } };
    const client = createRemoteClient({ target: { url: target.url, token: 'secret' }, logger: pino({ level: 'silent' }), control });

    try {
      client.start();
      await target.connection(1);
      target.sockets[0].send(JSON.stringify({ type: 'request', requestId: 'slow', method: 'GET', path: '/instance/fetchInstances' }));
      await started;

      let closed = false;
      const socketClosed = once(target.sockets[0], 'close').then(() => { closed = true; });
      const stopping = client.stop();

      // A request arriving mid-drain is refused, never executed.
      const refused = once(target.sockets[0], 'message');
      target.sockets[0].send(JSON.stringify({ type: 'request', requestId: 'late', method: 'GET', path: '/instance/fetchInstances' }));
      const [late] = await refused;
      expect(JSON.parse(String(late))).toEqual({
        type: 'response', requestId: 'late', status: 503,
        body: { status: 503, error: 'Service Unavailable', response: { message: 'Server is shutting down' } },
      });

      const reply = once(target.sockets[0], 'message');
      finish({ status: 200, body: [] });
      const [data] = await reply;
      expect(closed).toBe(false);
      expect(JSON.parse(String(data))).toEqual({ type: 'response', requestId: 'slow', status: 200, body: [] });
      expect(executions).toBe(1);
      await socketClosed;
      await stopping;
    } finally {
      finish?.({ status: 200, body: [] });
      await client.stop();
      await target.close();
    }
  });

  it('limits shutdown time when a control operation does not settle', async () => {
    const target = await createFakeTarget();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const control: ControlService = { execute: () => { entered(); return new Promise<ControlResponse>(() => {}); } };
    const client = createRemoteClient({ target: { url: target.url, token: 'secret' }, logger: pino({ level: 'silent' }), control });
    let stopped = false;

    try {
      client.start();
      await target.connection(1);
      target.sockets[0].send(JSON.stringify({ type: 'request', requestId: 'stuck', method: 'GET', path: '/instance/fetchInstances' }));
      await started;
      const startedAt = Date.now();
      await client.stop();
      stopped = true;
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      if (!stopped) await client.stop();
      await target.close();
    }
  }, 10_000);

  it('stops while the upgrade handshake is still pending', async () => {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TCP server did not bind a port');
    const target = { url: new URL(`ws://127.0.0.1:${address.port}`), token: 'secret' };
    const client = createRemoteClient({ target, logger: pino({ level: 'silent' }), control: unusedControl });
    let transport: Socket | undefined;

    try {
      const connected = once(server, 'connection');
      client.start();
      [transport] = await connected;
      await expect(client.stop()).resolves.toBeUndefined();
    } finally {
      await client.stop();
      transport?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('ignores a second start so stop() cannot leave a socket behind', async () => {
    const { target, client, close } = await startClient();
    try {
      await target.connection(1);
      client.start();
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(target.sockets).toHaveLength(1);
      await client.stop();
      expect(target.sockets.every((socket) => socket.readyState !== socket.OPEN)).toBe(true);
    } finally {
      await close();
    }
  });

  it('reconnects when start races an unfinished stop', async () => {
    const { target, client, close } = await startClient();
    try {
      await target.connection(1);
      const stopping = client.stop();
      client.start();

      await stopping;
      await expect(target.connection(2)).resolves.toBe('Bearer secret');
    } finally {
      await close();
    }
  }, 10_000);

  it('gives up instead of throwing when ws rejects the URL', async () => {
    const target = await createFakeTarget();
    // A fragment makes the ws constructor throw synchronously, including from the retry timer.
    const url = new URL(`${target.url.href}#frag`);
    const client = createRemoteClient({ target: { url, token: 'secret' }, logger: pino({ level: 'silent' }), control: unusedControl });
    try {
      expect(() => client.start()).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(target.sockets).toHaveLength(0);
    } finally {
      await client.stop();
      await target.close();
    }
  });
});
