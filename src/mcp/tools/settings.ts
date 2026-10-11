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
      description: 'Set whether an instance imports the chat history WhatsApp sends while pairing. WhatsApp only sends it during pairing, so for an instance that is already paired, enable it and then use logout_instance and scan a new QR.',
      inputSchema: z.object({
        instanceName,
        syncFullHistory: z.boolean().describe('true imports the history sent while pairing; false ignores it.'),
      }),
      handler: ({ instanceName: name, syncFullHistory }) => run('POST', `/settings/set/${name}`, { syncFullHistory }),
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
