import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createControlService, createControlValidator } from '../../src/api/control';
import { createMcpRouter } from '../../src/mcp/router';
import { createSettingsService } from '../../src/settings';
import { createWebhookService } from '../../src/webhooks';
import { createFakeChatService, createFakeInstanceService, createFakeSendService, createTestDb, silentLogger } from '../helpers';

/** The MCP router on a bare Express app, with fakes for everything the tools call. */
async function createMcpTestApp() {
  const instanceService = createFakeInstanceService();
  const instance = await instanceService.createInstance('acme');
  instance.status = 'open';

  const db = createTestDb();
  const webhookService = createWebhookService({ db });
  const controlService = createControlService({
    validator: await createControlValidator(),
    instanceService,
    webhookService,
    settingsService: createSettingsService({ db }),
    logger: silentLogger(),
  });

  const app = express();
  app.use('/mcp', createMcpRouter({
    instanceService,
    chatService: createFakeChatService(),
    sendService: createFakeSendService(),
    controlService,
    logger: silentLogger(),
  }));
  return app;
}

describe('MCP HTTP endpoint', () => {
  it('rejects a request without a Bearer token', async () => {
    const app = await createMcpTestApp();
    const res = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect(res.status).toBe(401);
  });

  it('rejects a request with the wrong Bearer token', async () => {
    const app = await createMcpTestApp();
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer not-the-key')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect(res.status).toBe(401);
  });

  it('completes the handshake, lists tools, and calls one', async () => {
    const app = await createMcpTestApp();
    const server = app.listen(0);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no listening port');
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
        authProvider: { token: async () => 'test-api-key-0000' },
      });
      const client = new Client({ name: 'mcp-test', version: '0.0.1' });
      await client.connect(transport);

      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        'send_text',
        'send_media',
        'list_chats',
        'list_messages',
        'create_instance',
      ]));

      const result = await client.callTool({
        name: 'list_chats', arguments: { instanceName: 'acme', before: 'cursor', limit: 10, search: 'alice' },
      });
      expect(result.isError).toBeFalsy();

      await client.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
