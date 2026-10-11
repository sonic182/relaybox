import type { Request, Response } from 'express';
import { isValidName, type InstanceService } from '../instances';
import { createInstanceForm, instanceList } from '../views';
import type { ControlService } from '../api/control';
import { ApiError } from '../api/error-core';

type InstanceAction = (name: string) => Promise<void>;

/** HTTP adapter for instance lifecycle operations. */
export function createInstancesController(instanceService: InstanceService, controlService: ControlService) {
  function list(_req: Request, res: Response): void {
    res.send(instanceList(instanceService.listInstances()));
  }

  function events(req: Request, res: Response): void {
    res.set({
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
    });
    res.flushHeaders();

    const send = () => {
      res.write(`event: instances\ndata: ${JSON.stringify(instanceList(instanceService.listInstances()))}\n\n`);
    };

    // Subscribe before the snapshot so no change slips between the two.
    const unsubscribe = instanceService.subscribe(send);
    // An instance can move between rendering the dashboard and this subscription, and a
    // reconnecting EventSource has missed everything since it dropped.
    send();
    req.once('close', unsubscribe);
  }

  async function create(req: Request, res: Response): Promise<void> {
    const name = req.body?.name;
    if (!isValidName(name)) {
      res.status(400).send(req.get('HX-Request')
        ? createInstanceForm(typeof name === 'string' ? name : '', ['Invalid instance name'], req.body?.syncFullHistory === 'on')
        : 'Invalid instance name');
      return;
    }

    if (req.body?.syncFullHistory !== undefined && req.body.syncFullHistory !== 'on') {
      res.status(400).send(createInstanceForm(name, ['Invalid history sync option']));
      return;
    }
    try {
      if (req.body?.syncFullHistory === 'on') {
        await controlService.execute({ method: 'POST', path: '/instance/create', body: { instanceName: name, syncFullHistory: true } });
      } else {
        if (instanceService.getInstance(name)) {
          res.status(400).send(createInstanceForm(name, ['That name is already taken']));
          return;
        }
        await instanceService.createInstance(name);
      }
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      res.status(400).send(createInstanceForm(name, ['Could not create instance. Check the name and try again.'], req.body?.syncFullHistory === 'on'));
      return;
    }
    res.set('HX-Retarget', '#instances');
    res.set('HX-Reswap', 'innerHTML');
    res.send(instanceList(instanceService.listInstances()));
  }

  /** The new name arrives in htmx's `HX-Prompt` header, not in a form body. */
  async function rename(req: Request, res: Response): Promise<void> {
    const { name } = req.params;
    const newName = req.get('HX-Prompt')?.trim();
    if (!isValidName(name) || !isValidName(newName)) {
      res.status(400).send('Invalid instance name');
      return;
    }

    if (newName !== name && instanceService.getInstance(newName)) {
      res.status(409).send('That name is already taken');
      return;
    }

    await instanceService.renameInstance(name, newName);
    res.send(instanceList(instanceService.listInstances()));
  }

  function actionHandler(action: InstanceAction) {
    return async (req: Request, res: Response): Promise<void> => {
      const { name } = req.params;
      if (!isValidName(name)) {
        res.status(400).send('Invalid instance name');
        return;
      }

      await action(name);
      res.send(instanceList(instanceService.listInstances()));
    };
  }

  return {
    list,
    events,
    create,
    rename,
    deleteOne: actionHandler((name) => instanceService.deleteInstance(name)),
    disconnect: actionHandler((name) => instanceService.disconnectInstance(name)),
    reconnect: actionHandler((name) => instanceService.reconnectInstance(name)),
    unpair: actionHandler((name) => instanceService.logoutInstance(name)),
  };
}
