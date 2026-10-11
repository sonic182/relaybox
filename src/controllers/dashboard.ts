import type { Request, Response } from 'express';
import type { InstanceService } from '../instances';
import { dashboardPage } from '../views';

export function createDashboardController(instanceService: InstanceService) {
  return {
    showDashboard(_req: Request, res: Response): void {
      res.send(dashboardPage(instanceService.listInstances()));
    },
  };
}
