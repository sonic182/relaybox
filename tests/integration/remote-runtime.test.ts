import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createFakeTarget } from '../fakeRemoteTarget';
import { createTestDb } from '../helpers';

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('could not reserve an HTTP port');
  return address.port;
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('remote runtime lifecycle', () => {
  it('connects after HTTP starts and closes on SIGTERM', async () => {
    expect(await createTestDb().instanceRecord.count()).toBe(0);
    const target = await createFakeTarget();
    const port = await availablePort();
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        REMOTE_SERVER_URL: target.url.toString(),
        REMOTE_SERVER_TOKEN: 'test-remote-token',
        // Set explicitly so a developer's .env cannot fill them in (loadEnvFile never overrides).
        LOG_DIRECTORY: '',
        ENABLE_DEV_MCP: 'false',
        // tests/setup.ts silences logs; the child's output is what a failure prints.
        LOG_LEVEL: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });

    try {
      await within(target.connection(1), 10_000);
      const http = await fetch(`http://127.0.0.1:${port}/swagger.json`);
      expect(http.status).toBe(200);

      const reply = once(target.sockets[0], 'message');
      target.sockets[0].send(JSON.stringify({
        type: 'request', requestId: 'list', method: 'GET', path: '/instance/fetchInstances',
      }));
      const [data] = await within(reply, 5_000);
      expect(JSON.parse(data.toString())).toEqual({ type: 'response', requestId: 'list', status: 200, body: [] });

      const closed = once(target.sockets[0], 'close');
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await within(closed, 7_000);
      const [code, signal] = await within(exited, 10_000);
      expect({ code, signal }).toEqual({ code: 0, signal: null });
    } catch (error) {
      throw new Error(`runtime lifecycle failed: ${String(error)}\n${output}`, { cause: error });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await within(exited, 3_000).catch(() => {});
      }
      await target.close();
    }
  }, 20_000);
});
