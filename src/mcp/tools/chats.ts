import { open } from 'node:fs/promises';
import { z } from 'zod';
import { notFound } from '../../api/errors';
import { findMessagesResponse, readConvertToMp4, readUpdateMessage } from '../../api/inputs';
import { requireApiInstance } from '../../api/instances';
import type { ChatService } from '../../chats';
import { MCP_INLINE_MEDIA_BYTES } from '../../config';
import type { InstanceService } from '../../instances';
import { buildMediaUrl, resolveStoredMediaPath } from '../../mediaAccess';
import type { SendService } from '../../sends';
import { defineTool, jsonResult, runTool, type McpTool } from '../tool';

const instanceName = z.string().min(1).describe('Instance name ([a-zA-Z0-9_-], 1-32 characters).');

/** Chat lookup, history, and read/write tools. */
export function createChatTools(
  instances: InstanceService,
  sends: SendService,
  chats: ChatService,
): McpTool[] {
  return [
    defineTool({
      name: 'find_messages',
      title: 'Find message',
      description: 'Look up one stored message by its key id, for example one seen in list_messages.',
      inputSchema: z.object({ instanceName, keyId: z.string().describe('The message key id (key.id) of a stored message.') }),
      readOnly: true,
      handler: async (args) => runTool(async () => {
        const instance = requireApiInstance(instances, args.instanceName);
        const found = await chats.findMessage(args.instanceName, args.keyId);
        return jsonResult(findMessagesResponse(instance.id, found));
      }),
    }),

    defineTool({
      name: 'get_media',
      title: 'Get message media',
      description: 'Download and cache unavailable stored message media on demand from WhatsApp, then return a short-lived signed URL and mimetype. The instance must be connected for uncached media; older files may be unavailable. The URL needs no API key and expires after a few minutes, so download it promptly. Set inline only for small files: the base64 is added to the result and consumes your context.',
      inputSchema: z.object({
        instanceName,
        keyId: z.string().describe('The message key id.'),
        convertToMp4: z.boolean().optional().describe('Rejected when true; no conversion happens here.'),
        inline: z.boolean().optional().describe('Include base64 for media within the inline limit.'),
      }),
      handler: async (args) => runTool(async () => {
        requireApiInstance(instances, args.instanceName);
        readConvertToMp4(args);

        const found = await chats.getMedia(args.instanceName, args.keyId);
        const file = found ? resolveStoredMediaPath(args.instanceName, found.path) : undefined;
        if (!found || !file) throw notFound('Message media not found');

        const { url, expiresAt } = buildMediaUrl(args.instanceName, args.keyId);
        const result = jsonResult({
          url,
          expiresAt,
          mimetype: found.mimetype,
          fileName: found.path,
          messageType: found.messageType,
        });

        if (args.inline && MCP_INLINE_MEDIA_BYTES > 0) {
          const handle = await open(file, 'r');
          try {
            if ((await handle.stat()).size <= MCP_INLINE_MEDIA_BYTES) {
              // Bound the read too: a file can grow after stat, and reads may be partial.
              const buffer = Buffer.alloc(MCP_INLINE_MEDIA_BYTES + 1);
              let size = 0;
              while (size < buffer.length) {
                const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
                if (!bytesRead) break;
                size += bytesRead;
              }
              if (size <= MCP_INLINE_MEDIA_BYTES) {
                result.content.push({ type: 'text', text: buffer.subarray(0, size).toString('base64') });
              }
            }
          } finally {
            await handle.close();
          }
        }
        return result;
      }),
    }),

    defineTool({
      name: 'update_message',
      title: 'Edit message',
      description: 'Edit the text of a message this instance sent. The recipient sees the change, so confirm which message first.',
      inputSchema: z.object({
        instanceName,
        number: z.string().describe('Bare number or qualified JID of the chat the message is in.'),
        text: z.string().min(1).describe('The new message text.'),
        key: z.object({
          id: z.string().describe('Key id of the message to edit.'),
          remoteJid: z.string().describe('JID of the chat the message is in.'),
          fromMe: z.boolean().describe('Must be true: only messages this instance sent can be edited.'),
          participant: z.string().optional().describe('Sender JID, for group messages.'),
        }),
        idempotencyKey: z.string().optional().describe('Retry-safe key; the edit runs at most once per key.'),
      }),
      handler: async (args) => runTool(async () => {
        const instance = requireApiInstance(instances, args.instanceName);
        const input = readUpdateMessage(args);
        const message = await sends.once(instance.id, args.idempotencyKey, () => instances.editMessage(args.instanceName, input));
        return jsonResult(message);
      }),
    }),

    defineTool({
      name: 'list_chats',
      title: 'List chats',
      description: 'List chats of an instance, most recently active first. Each chat carries the JID for list_messages and other chat tools. Use `before` from a previous result to continue; `search` matches part of a chat name or JID, case-insensitively.',
      inputSchema: z.object({
        instanceName,
        before: z.string().optional().describe('Cursor from a previous list_chats result.'),
        limit: z.number().int().positive().max(200).optional().describe('Maximum chats to return (1-200).'),
        search: z.string().optional().describe('Case-insensitive partial match against chat name or JID.'),
      }),
      readOnly: true,
      handler: async (args) => runTool(async () => {
        requireApiInstance(instances, args.instanceName);
        return jsonResult(await chats.listChats(args.instanceName, {
          before: args.before,
          limit: args.limit,
          search: args.search,
        }));
      }),
    }),

    defineTool({
      name: 'list_messages',
      title: 'List messages',
      description: 'List a page of stored messages for a chat, oldest first. Pass the cursor of a page back as `before` to get the previous (older) page.',
      inputSchema: z.object({
        instanceName,
        jid: z.string().describe('The chat JID, for example from list_chats.'),
        before: z.string().optional().describe('Cursor from a previous page.'),
        limit: z.number().int().positive().max(200).optional().describe('Maximum messages to return (1-200).'),
      }),
      readOnly: true,
      handler: async (args) => runTool(async () => {
        requireApiInstance(instances, args.instanceName);
        return jsonResult(await chats.listMessages(args.instanceName, args.jid, { before: args.before, limit: args.limit }));
      }),
    }),

    defineTool({
      name: 'send_chat_message',
      title: 'Send chat message',
      description: 'Send a text message into an existing chat by JID. This delivers a real message and cannot be undone. Unlike send_text it takes no options such as quoting or mentions.',
      inputSchema: z.object({
        instanceName,
        jid: z.string().describe('The chat JID, for example from list_chats.'),
        text: z.string().min(1).describe('Message body.'),
      }),
      handler: async (args) => runTool(async () => {
        requireApiInstance(instances, args.instanceName);
        return jsonResult(await instances.sendText(args.instanceName, args.jid, args.text));
      }),
    }),

    defineTool({
      name: 'get_chat_avatar',
      title: 'Get chat avatar',
      description: 'Return the WhatsApp profile-picture URL for a chat, or null when none is set.',
      inputSchema: z.object({ instanceName, jid: z.string().describe('The chat JID.') }),
      readOnly: true,
      handler: async (args) => runTool(async () => {
        requireApiInstance(instances, args.instanceName);
        const url = await instances.getProfilePictureUrl(args.instanceName, args.jid);
        return jsonResult({ url: url ?? null });
      }),
    }),
  ];
}
