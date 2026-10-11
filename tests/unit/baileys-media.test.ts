import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { downloadMediaMessage } from 'baileys';
import { describe, expect, it } from 'vitest';

// Exercise the real dependency: a mock of downloadMediaMessage cannot detect
// Baileys dropping RequestInit.signal before it reaches fetch.
describe('Baileys media download cancellation', () => {
  it.each(['headers', 'body'] as const)('aborts a stalled %s download', async (phase) => {
    const server = createServer((_req, res) => {
      if (phase === 'body') {
        res.writeHead(200);
        res.write(Buffer.alloc(16));
      }
      // Deliberately never finish the headers/body.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const download = (async () => {
        const stream = await downloadMediaMessage({
          key: { id: 'STALLED', remoteJid: 'chat@s.whatsapp.net', fromMe: false },
          message: { imageMessage: { url: `http://127.0.0.1:${port}/media`, mediaKey: Buffer.alloc(32) } },
        }, 'stream', { options: { signal: AbortSignal.timeout(100) } });
        for await (const chunk of stream) void chunk;
      })();
      // Also bounds the regression's failure path when the signal is discarded.
      const deadline = new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => reject(new Error('media download did not abort')), 2000);
      });
      await expect(Promise.race([download, deadline])).rejects.toSatisfy(
        (error: Error) => error.name === 'TimeoutError' || error.name === 'AbortError',
      );
    } finally {
      clearTimeout(watchdog);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
