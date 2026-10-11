import { Router } from 'express';
import { controlPath, type ControlService } from './control';

/** Evolution-compatible instance routes, mounted under `/instance`. */
export function createInstanceRoutes(control: ControlService): Router {
  const router = Router();
  for (const [method, path] of [
    ['post', '/create'],
    ['get', '/fetchInstances'],
    ['get', '/connectionState/:instanceName'],
    ['get', '/connect/:instanceName'],
    ['delete', '/logout/:instanceName'],
    ['delete', '/delete/:instanceName'],
    ['post', '/rename/:instanceName'],
    ['post', '/disconnect/:instanceName'],
  ] as const) {
    router[method](path, async (req, res) => {
      const response = await control.execute({ method: req.method, path: controlPath(req.originalUrl), body: req.body });
      res.status(response.status).json(response.body);
    });
  }
  return router;
}
