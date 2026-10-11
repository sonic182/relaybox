import type { Request, Response } from 'express';
import { uiDemoResponse, uiPage, uiTick } from '../ui';

export function show(_req: Request, res: Response): void {
  res.send(uiPage());
}

export function demo(_req: Request, res: Response): void {
  res.send(uiDemoResponse());
}

export function tick(_req: Request, res: Response): void {
  res.send(uiTick());
}
