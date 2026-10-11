import { Router } from 'express';
import { controlPath, type ControlService } from './control';

/** The reference's `POST /set/:instanceName` and `GET /find/:instanceName` pair, dispatched through the control service. */
export function createSetFindRoutes(control: ControlService): Router {
  const router = Router();
  router.post('/set/:instanceName', async (req, res) => {
    const response = await control.execute({ method: req.method, path: controlPath(req.originalUrl), body: req.body });
    res.status(response.status).json(response.body);
  });
  router.get('/find/:instanceName', async (req, res) => {
    const response = await control.execute({ method: req.method, path: controlPath(req.originalUrl) });
    res.status(response.status).json(response.body);
  });
  return router;
}
