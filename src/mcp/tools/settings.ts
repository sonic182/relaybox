import { z } from 'zod';
import type { ControlService } from '../../api/control';
import { controlRunner, defineTool, type McpTool } from '../tool';

const instanceName = z.string().min(1).describe('Instance name ([a-zA-Z0-9_-], 1-32 characters).');

/** Instance settings tools, dispatched through the control service. */
export function createSettingsTools(control: ControlService): McpTool[] {
  const run = controlRunner(control);

  return [
    defineTool({
      name: 'set_settings',
      title: 'Configure instance settings',
      description: 'Change instance settings; omitted settings keep their value, but give at least one. syncFullHistory imports the chat history WhatsApp sends while pairing; WhatsApp only sends it during pairing, so for an instance that is already paired, enable it and then use logout_instance and scan a new QR. alwaysOnline shows the number as online to contacts while connected and applies immediately.',
      inputSchema: z.object({
        instanceName,
        syncFullHistory: z.boolean().optional().describe('true imports the history sent while pairing; false ignores it.'),
        alwaysOnline: z.boolean().optional().describe('true shows the number as online while connected; false keeps it offline so the phone keeps notifications.'),
      }),
      handler: ({ instanceName: name, ...settings }) => run('POST', `/settings/set/${name}`, settings),
    }),

    defineTool({
      name: 'find_settings',
      title: 'Get instance settings',
      description: 'Return the settings of an instance; defaults apply until set_settings is called.',
      inputSchema: z.object({ instanceName }),
      readOnly: true,
      handler: ({ instanceName: name }) => run('GET', `/settings/find/${name}`),
    }),
  ];
}
