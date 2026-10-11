import { McpServer } from '@modelcontextprotocol/server';
import type { Logger } from 'pino';
import type { ControlService } from '../api/control';
import { mapApiError } from '../api/error-core';
import type { ChatService } from '../chats';
import type { InstanceService } from '../instances';
import type { SendService } from '../sends';
import { createChatTools } from './tools/chats';
import { createInstanceTools } from './tools/instances';
import { createMessageTools } from './tools/messages';
import { createSettingsTools } from './tools/settings';
import { createWebhookTools } from './tools/webhooks';
import { apiErrorToToolResult, type McpTool, type ToolResult } from './tool';

/** Everything the MCP tools need, kept explicit so a fake with a missing method fails typecheck. */
export type McpDependencies = {
  instanceService: InstanceService;
  chatService: ChatService;
  sendService: SendService;
  controlService: ControlService;
  logger: Logger;
  toolFilter?: McpToolFilter;
};

export type McpToolFilter = {
  readOnly?: boolean;
  allow?: string[];
};

/** The full tool list, in the order clients will see it. */
export function createMcpTools(deps: McpDependencies): McpTool[] {
  return [
    ...createInstanceTools(deps.controlService),
    ...createWebhookTools(deps.controlService),
    ...createSettingsTools(deps.controlService),
    ...createMessageTools(deps.instanceService, deps.sendService),
    ...createChatTools(deps.instanceService, deps.sendService, deps.chatService),
  ];
}

export function selectMcpTools(tools: McpTool[], { readOnly = false, allow }: McpToolFilter = {}): McpTool[] {
  const unknown = allow?.filter((name) => !tools.some((tool) => tool.name === name)) ?? [];
  if (unknown.length) throw new Error(`MCP_TOOLS names unknown tools: ${unknown.join(', ')}`);

  const selected = tools.filter((tool) => (!readOnly || tool.readOnly) && (!allow || allow.includes(tool.name)));
  if (!selected.length) throw new Error('MCP_READ_ONLY and MCP_TOOLS leave no MCP tools enabled');

  return selected;
}

/**
 * Registers one tool. A thrown `ApiError` becomes a tool error; anything else is logged and
 * reported as a generic failure so internals never reach the client.
 */
function register(server: McpServer, tool: McpTool, logger: Logger): void {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: {
        ...(tool.readOnly ? { readOnlyHint: true } : {}),
        ...(tool.destructive ? { destructiveHint: true } : {}),
      },
    },
    async (args: unknown) => {
      try {
        return await tool.handler(args as Record<string, unknown>);
      } catch (error) {
        const mapped = mapApiError(error);
        if (mapped) return apiErrorToToolResult(mapped);
        logger.error({ err: error, tool: tool.name }, 'mcp tool failed');
        return { content: [{ type: 'text', text: 'Internal Server Error' }], isError: true } satisfies ToolResult;
      }
    },
  );
}

/** Guidance that spans several tools, sent once to the client instead of repeated in every description. */
export const MCP_INSTRUCTIONS = `WhatsApp gateway: each instance is one paired WhatsApp session, identified by instanceName.

Typical flow: fetch_instances to find the instance and get_connection_state to check it is open; list_chats to find a chat and its JID; list_messages with that JID to read history; use a message key id from the history with find_messages or get_media.

Addressing: send_text, send_media, send_audio and update_message take \`number\`, a bare phone number with country code and no plus sign or a full JID (user@s.whatsapp.net, group@g.us). list_messages, send_chat_message and get_chat_avatar take \`jid\`.

Media: get_media downloads and caches uncached media through the connected WhatsApp instance; older files may be unavailable. It returns a signed URL that expires after a few minutes and needs no API key, so download it promptly. Pass inline only for small files, because the base64 goes into your context. To send media prefer mediaUrl or audioUrl over base64.

History: WhatsApp sends old chats only while pairing, and they are imported only when the instance setting syncFullHistory is true (set it in create_instance or set_settings before scanning the QR). An instance that is already paired needs it enabled, then logout_instance and a new QR.

Side effects: send_* and update_message deliver real messages to real people and cannot be unsent. logout_instance unpairs the session and needs a new QR scan; delete_instance removes the instance and all of its stored data. Confirm the target instance and recipient before calling them, and use idempotencyKey when a send might be retried.`;

/** Builds a fresh server per connection, as `createMcpHandler` expects a factory. */
export function createMcpServer(deps: McpDependencies): McpServer {
  const server = new McpServer({ name: 'relaybox', version: '0.2.1' }, { instructions: MCP_INSTRUCTIONS });
  for (const tool of selectMcpTools(createMcpTools(deps), deps.toolFilter)) register(server, tool, deps.logger);
  return server;
}
