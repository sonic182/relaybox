import { z } from 'zod';
import type { ControlService } from '../../api/control';
import { controlRunner, dataUrlToImage, defineTool, type McpTool, type ToolResult } from '../tool';

const instanceName = z.string().min(1).describe('Instance name ([a-zA-Z0-9_-], 1-32 characters).');

/** Appends the pairing QR, when the response carries one, as an image block. */
function appendQrImage(result: ToolResult): void {
  const body = result.structuredContent as { qrcode?: { base64?: string }; base64?: string } | undefined;
  const image = dataUrlToImage(body?.qrcode?.base64 ?? body?.base64);
  if (image) result.content.push(image);
}

/** Instance lifecycle tools. All dispatch through the OpenAPI-validated control service. */
export function createInstanceTools(control: ControlService): McpTool[] {
  const run = controlRunner(control);

  return [
    defineTool({
      name: 'create_instance',
      title: 'Create instance',
      description: 'Create a WhatsApp instance. It starts unpaired: set qrcode to true to wait for the pairing QR in the response, then scan it from the phone (WhatsApp, Linked devices).',
      inputSchema: z.object({
        instanceName,
        qrcode: z.boolean().optional().describe('Wait for the pairing QR and include it in the response.'),
        integration: z.literal('WHATSAPP-BAILEYS').optional().describe('The only supported integration; may be omitted.'),
        syncFullHistory: z.boolean().optional().describe('Import the chat history WhatsApp sends while pairing. Off by default; it must be on before the QR is scanned.'),
        alwaysOnline: z.boolean().optional().describe('Show the number as online to contacts while connected. Off by default.'),
        webhook: z.record(z.string(), z.unknown()).optional().describe('Initial webhook configuration; same fields as set_webhook, which is simpler to use afterwards.'),
      }),
      handler: async (args) => {
        const result = await run('POST', '/instance/create', args);
        appendQrImage(result);
        return result;
      },
    }),

    defineTool({
      name: 'fetch_instances',
      title: 'List instances',
      description: 'List the instances visible to this credential with their state. Pass instanceName or instanceId to filter to one.',
      inputSchema: z.object({
        instanceName: instanceName.optional(),
        instanceId: z.string().optional().describe('Internal instance id, as returned by this tool.'),
      }),
      readOnly: true,
      handler: async ({ instanceName: name, instanceId }) => {
        const query = new URLSearchParams();
        if (name) query.set('instanceName', name);
        if (instanceId) query.set('instanceId', instanceId);
        const suffix = query.size ? `?${query.toString()}` : '';
        return run('GET', `/instance/fetchInstances${suffix}`);
      },
    }),

    defineTool({
      name: 'get_connection_state',
      title: 'Get connection state',
      description: 'Return the connection state of one instance (for example open, connecting or close). Check it is open before sending messages.',
      inputSchema: z.object({ instanceName }),
      readOnly: true,
      handler: ({ instanceName: name }) => run('GET', `/instance/connectionState/${name}`),
    }),

    defineTool({
      name: 'connect_instance',
      title: 'Connect instance',
      description: 'Reconnect an instance whose state is close. When the session is no longer paired it returns a pairing QR to scan from the phone.',
      inputSchema: z.object({ instanceName }),
      handler: async ({ instanceName: name }) => {
        const result = await run('GET', `/instance/connect/${name}`);
        appendQrImage(result);
        return result;
      },
    }),

    defineTool({
      name: 'logout_instance',
      title: 'Log out instance',
      description: 'Unpair the WhatsApp session: the stored credentials are wiped, so a later connect needs a fresh QR scan. The instance itself remains. Use disconnect_instance to only close the connection.',
      inputSchema: z.object({ instanceName }),
      destructive: true,
      handler: ({ instanceName: name }) => run('DELETE', `/instance/logout/${name}`),
    }),

    defineTool({
      name: 'delete_instance',
      title: 'Delete instance',
      description: 'Permanently delete the instance and all of its stored state, including chats and media. This cannot be undone.',
      inputSchema: z.object({ instanceName }),
      destructive: true,
      handler: ({ instanceName: name }) => run('DELETE', `/instance/delete/${name}`),
    }),

    defineTool({
      name: 'rename_instance',
      title: 'Rename instance',
      description: 'Rename an instance; its credentials follow the instance, so it stays paired. Later calls must use the new name.',
      inputSchema: z.object({ instanceName, newName: instanceName.describe('The new instance name ([a-zA-Z0-9_-], 1-32 characters).') }),
      handler: ({ instanceName: name, newName }) => run('POST', `/instance/rename/${name}`, { newName }),
    }),

    defineTool({
      name: 'disconnect_instance',
      title: 'Disconnect instance',
      description: 'Close the instance connection without unpairing it; connect_instance brings it back without a new QR scan.',
      inputSchema: z.object({ instanceName }),
      handler: ({ instanceName: name }) => run('POST', `/instance/disconnect/${name}`),
    }),
  ];
}
