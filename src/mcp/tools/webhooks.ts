import { z } from 'zod';
import type { ControlService } from '../../api/control';
import { controlRunner, defineTool, type McpTool } from '../tool';

const instanceName = z.string().min(1).describe('Instance name ([a-zA-Z0-9_-], 1-32 characters).');

/** Mirrors the reference webhook body; the control service re-validates it against OpenAPI. */
const webhookConfig = z.object({
  url: z.string().describe('Callback URL.'),
  enabled: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).nullable().optional(),
  signatureSecret: z.string().nullable().optional().describe('HMAC secret; write-only.'),
  signatureEnabled: z.boolean().optional(),
  byEvents: z.boolean().optional(),
  base64: z.boolean().optional(),
  events: z.array(z.string()).optional().describe('Empty or omitted subscribes to every supported event.'),
});

/** Webhook configuration tools, dispatched through the control service. */
export function createWebhookTools(control: ControlService): McpTool[] {
  const run = controlRunner(control);

  return [
    defineTool({
      name: 'set_webhook',
      title: 'Configure webhook',
      description: 'Create or update where an instance sends its events (messages, connection changes). Send the complete configuration; use find_webhook to see the current one first.',
      inputSchema: z.object({ instanceName, webhook: webhookConfig }),
      handler: ({ instanceName: name, webhook }) => run('POST', `/webhook/set/${name}`, { webhook }),
    }),

    defineTool({
      name: 'find_webhook',
      title: 'Get webhook',
      description: 'Return the stored webhook configuration for an instance. The signature secret is write-only and is not returned.',
      inputSchema: z.object({ instanceName }),
      readOnly: true,
      handler: ({ instanceName: name }) => run('GET', `/webhook/find/${name}`),
    }),
  ];
}
