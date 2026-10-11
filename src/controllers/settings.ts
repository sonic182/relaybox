import type { Request, Response } from 'express';
import { readInstanceName } from './requests';
import type { SettingsService } from '../settings';
import { InstanceNotFoundError } from '../webhooks';
import { instanceSettingsPage } from '../views';

/** Cookie-authenticated HTML adapter for the shared instance settings service. */
export function createSettingsController(service: SettingsService) {
  async function respond(req: Request, res: Response, save: boolean): Promise<void> {
    const name = readInstanceName(req, res);
    if (!name) return;
    try {
      const value = req.body?.syncFullHistory;
      if (save && value !== undefined && value !== 'on') {
        res.status(400).send(instanceSettingsPage(name, await service.getSettings(name), { error: 'Invalid history sync option' }));
        return;
      }
      const settings = save
        ? await service.setSettings(name, { syncFullHistory: value === 'on' })
        : await service.getSettings(name);
      res.send(instanceSettingsPage(name, settings, { saved: save }));
    } catch (err) {
      if (!(err instanceof InstanceNotFoundError)) throw err;
      res.status(404).send('Instance not found');
    }
  }
  return {
    show: (req: Request, res: Response) => respond(req, res, false),
    save: (req: Request, res: Response) => respond(req, res, true),
  };
}
