import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ControlResponse, ControlService } from '../../src/api/control';
import { MCP_INLINE_MEDIA_BYTES } from '../../src/config';
import { createChatTools } from '../../src/mcp/tools/chats';
import { createInstanceTools } from '../../src/mcp/tools/instances';
import { createMessageTools } from '../../src/mcp/tools/messages';
import { createWebhookTools } from '../../src/mcp/tools/webhooks';
import { createMcpTools, selectMcpTools } from '../../src/mcp/server';
import type { McpTool, ToolResult } from '../../src/mcp/tool';
import { createFakeChatService, createFakeInstanceService, createFakeSendService, silentLogger } from '../helpers';

function toolByName(tools: McpTool[], name: string): McpTool {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool;
}

function textOf(result: ToolResult): string {
  const block = result.content.find((item) => item.type === 'text');
  if (!block || block.type !== 'text') throw new Error('no text content');
  return block.text;
}

function fakeControl(response: ControlResponse = { status: 200, body: { ok: true } }): ControlService {
  return { execute: vi.fn(async () => response) };
}

/** An instance that is open, so send tools pass the connectivity guard. */
async function openInstance(name = 'acme') {
  const instances = createFakeInstanceService();
  const instance = await instances.createInstance(name);
  instance.status = 'open';
  return { instances, instance };
}

describe('instance tools', () => {
  it('dispatches through the control service with the instance path', async () => {
    const control = fakeControl();
    await toolByName(createInstanceTools(control), 'get_connection_state').handler({ instanceName: 'acme' });

    expect(control.execute).toHaveBeenCalledWith({
      method: 'GET',
      path: '/instance/connectionState/acme',
      body: undefined,
    });
  });

  it('maps a 4xx control response to a tool error', async () => {
    const control = fakeControl({ status: 404, body: { status: 404, error: 'Not Found', response: { message: 'nope' } } });
    const result = await toolByName(createInstanceTools(control), 'delete_instance').handler({ instanceName: 'ghost' });

    expect(result.isError).toBe(true);
  });

  it('appends a pairing QR as an image block', async () => {
    const control = fakeControl({ status: 201, body: { instance: {}, qrcode: { base64: 'data:image/png;base64,AAAA' } } });
    const result = await toolByName(createInstanceTools(control), 'create_instance').handler({ instanceName: 'acme', qrcode: true });

    expect(result.content).toContainEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' });
  });
});

describe('webhook tools', () => {
  it('forwards the webhook body', async () => {
    const control = fakeControl();
    await toolByName(createWebhookTools(control), 'set_webhook').handler({
      instanceName: 'acme',
      webhook: { url: 'https://consumer.example/hook' },
    });

    expect(control.execute).toHaveBeenCalledWith({
      method: 'POST',
      path: '/webhook/set/acme',
      body: { webhook: { url: 'https://consumer.example/hook' } },
    });
  });
});

describe('message tools', () => {
  it('reuses the HTTP reader and forwards the idempotency key', async () => {
    const { instances, instance } = await openInstance();
    const sends = createFakeSendService();
    const result = await toolByName(createMessageTools(instances, sends), 'send_text').handler({
      instanceName: 'acme',
      number: '5511888888888',
      text: 'hi',
      idempotencyKey: 'k1',
    });

    expect(sends.once).toHaveBeenCalledWith(instance.id, 'k1', expect.any(Function));
    expect(instances.sendText).toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
  });

  it('maps an invalid recipient to a tool error before sending', async () => {
    const { instances } = await openInstance();
    const sends = createFakeSendService();
    const result = await toolByName(createMessageTools(instances, sends), 'send_text').handler({
      instanceName: 'acme',
      number: '!!!',
      text: 'hi',
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual(JSON.parse(textOf(result)));
    expect(instances.sendText).not.toHaveBeenCalled();
  });

  it('rejects a media call that sets both a URL and base64', async () => {
    const { instances } = await openInstance();
    const result = await toolByName(createMessageTools(instances, createFakeSendService()), 'send_media').handler({
      instanceName: 'acme',
      number: '5511888888888',
      mediatype: 'image',
      mediaUrl: 'https://consumer.example/receipt.png',
      mediaBase64: 'AAAA',
    });

    expect(result.isError).toBe(true);
    expect(instances.sendMedia).not.toHaveBeenCalled();
  });

  it('rejects inline base64 over the configured cap', async () => {
    const { instances } = await openInstance();
    const oversized = Buffer.alloc(MCP_INLINE_MEDIA_BYTES + 1).toString('base64');
    const result = await toolByName(createMessageTools(instances, createFakeSendService()), 'send_media').handler({
      instanceName: 'acme',
      number: '5511888888888',
      mediatype: 'image',
      mediaBase64: oversized,
    });

    expect(result.isError).toBe(true);
    expect(instances.sendMedia).not.toHaveBeenCalled();
  });

  it('sends a media URL through the send service', async () => {
    const { instances } = await openInstance();
    const result = await toolByName(createMessageTools(instances, createFakeSendService()), 'send_media').handler({
      instanceName: 'acme',
      number: '5511888888888',
      mediatype: 'document',
      mediaUrl: 'https://consumer.example/invoices/recibo.pdf',
    });

    expect(result.isError).toBeUndefined();
    expect(instances.sendMedia).toHaveBeenCalledWith(
      'acme',
      '5511888888888',
      'document',
      'https://consumer.example/invoices/recibo.pdf',
      undefined,
      expect.anything(),
    );
  });

  it('sends a voice note from a URL', async () => {
    const { instances } = await openInstance();
    const result = await toolByName(createMessageTools(instances, createFakeSendService()), 'send_audio').handler({
      instanceName: 'acme',
      number: '5511888888888',
      audioUrl: 'https://consumer.example/voice.mp3',
    });

    expect(result.isError).toBeUndefined();
    expect(instances.sendAudio).toHaveBeenCalled();
  });
});

describe('chat tools', () => {
  const found = {
    key: { remoteJid: '5511@s.whatsapp.net', fromMe: false, id: 'm1' },
    pushName: 'Ana',
    message: { conversation: 'hola' },
    contextInfo: undefined,
    messageType: 'conversation',
    messageTimestamp: 1,
    status: 'READ',
    media: null,
  };

  it('returns the findMessages envelope with the instance id', async () => {
    const { instances, instance } = await openInstance();
    const chats = createFakeChatService({ findMessage: vi.fn(async () => found) });
    const result = await toolByName(createChatTools(instances, createFakeSendService(), chats), 'find_messages').handler({
      instanceName: 'acme',
      keyId: 'm1',
    });

    const body = JSON.parse(textOf(result)) as { messages: { records: { instanceId: string }[] } };
    expect(body.messages.records[0].instanceId).toBe(instance.id);
  });

  it('returns a signed media URL and optional inline base64', async () => {
    const { instances } = await openInstance();
    const directory = join(process.env.MEDIA_DIR!, 'acme');
    mkdirSync(directory, { recursive: true });
    const bytes = Buffer.from('hello-media');
    writeFileSync(join(directory, 'pic.png'), bytes);

    try {
      const chats = createFakeChatService({
        getMedia: vi.fn(async () => ({ messageType: 'imageMessage', path: 'pic.png', mimetype: 'image/png' })),
      });
      const result = await toolByName(createChatTools(instances, createFakeSendService(), chats), 'get_media').handler({
        instanceName: 'acme',
        keyId: 'm1',
        inline: true,
      });

      const body = JSON.parse(textOf(result)) as { url: string };
      expect(body.url).toContain('/media/acme/m1');
      expect(body.url).toContain('sig=');
      expect(result.content).toContainEqual({ type: 'text', text: bytes.toString('base64') });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('returns only a URL for oversized media without reading the entire file synchronously', async () => {
    const { instances } = await openInstance();
    const directory = join(process.env.MEDIA_DIR!, 'acme');
    mkdirSync(directory, { recursive: true });
    const file = join(directory, 'large.mp4');
    writeFileSync(file, '');
    truncateSync(file, MCP_INLINE_MEDIA_BYTES + 1);
    const original = fs.readFileSync;
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === file) throw new Error('Oversized media must not be read in full');
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      const chats = createFakeChatService({
        getMedia: vi.fn(async () => ({ messageType: 'videoMessage', path: 'large.mp4', mimetype: 'video/mp4' })),
      });
      const result = await toolByName(createChatTools(instances, createFakeSendService(), chats), 'get_media').handler({
        instanceName: 'acme', keyId: 'm1', inline: true,
      });
      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.structuredContent?.url).toContain('/media/acme/m1');
    } finally {
      read.mockRestore();
      syncBuiltinESMExports();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('lists chats and messages', async () => {
    const { instances } = await openInstance();
    const chats = createFakeChatService({
      listChats: vi.fn(async () => ({ chats: [{ remoteJid: '5511@s.whatsapp.net', name: 'Ana', lastMessageAt: null, lastMessagePreview: null }], cursor: 'next-chat' })),
      listMessages: vi.fn(async () => ({ messages: [], cursor: 'next' })),
    });
    const tools = createChatTools(instances, createFakeSendService(), chats);

    const chatsResult = await toolByName(tools, 'list_chats').handler({
      instanceName: 'acme', before: 'previous', limit: 25, search: 'ana',
    });
    expect(textOf(chatsResult)).toContain('5511@s.whatsapp.net');
    expect(textOf(chatsResult)).toContain('next-chat');
    expect(chats.listChats).toHaveBeenCalledWith('acme', {
      before: 'previous', limit: 25, search: 'ana',
    });

    const messagesResult = await toolByName(tools, 'list_messages').handler({ instanceName: 'acme', jid: '5511@s.whatsapp.net' });
    expect(textOf(messagesResult)).toContain('next');
  });

  it('sends into a chat and reads its avatar', async () => {
    const { instances } = await openInstance();
    const tools = createChatTools(instances, createFakeSendService(), createFakeChatService());

    const sent = await toolByName(tools, 'send_chat_message').handler({ instanceName: 'acme', jid: '5511@s.whatsapp.net', text: 'hi' });
    expect(sent.isError).toBeUndefined();
    expect(instances.sendText).toHaveBeenCalledWith('acme', '5511@s.whatsapp.net', 'hi');

    const avatar = await toolByName(tools, 'get_chat_avatar').handler({ instanceName: 'acme', jid: '5511@s.whatsapp.net' });
    expect(textOf(avatar)).toContain('"url": null');
  });
});

describe('tool selection', () => {
  const tools = () => createMcpTools({
    instanceService: createFakeInstanceService(),
    chatService: createFakeChatService(),
    sendService: createFakeSendService(),
    controlService: fakeControl(),
    logger: silentLogger(),
  });
  const names = (selected: McpTool[]) => selected.map((tool) => tool.name);

  it('keeps every tool by default', () => {
    expect(selectMcpTools(tools())).toHaveLength(tools().length);
  });

  it('drops tools that send, change or delete anything in read-only mode', () => {
    const selected = names(selectMcpTools(tools(), { readOnly: true }));

    expect(selected).toEqual(expect.arrayContaining(['list_chats', 'list_messages', 'fetch_instances']));
    expect(selected.some((name) => name.startsWith('send_') || ['delete_instance', 'logout_instance', 'set_webhook'].includes(name))).toBe(false);
  });

  it('limits the set to an allowlist, combined with read-only mode', () => {
    expect(names(selectMcpTools(tools(), { allow: ['list_chats', 'send_text'] }))).toEqual(['send_text', 'list_chats']);
    expect(names(selectMcpTools(tools(), { readOnly: true, allow: ['list_chats', 'send_text'] }))).toEqual(['list_chats']);
  });

  it('rejects an allowlist naming a tool that does not exist', () => {
    expect(() => selectMcpTools(tools(), { allow: ['list_chats', 'send_everything'] })).toThrow('send_everything');
  });
});
