import type { Request, Response } from 'express';
import { isValidName } from '../instances';

export function readInstanceName(req: Request, res: Response): string | undefined {
  const { name } = req.params;
  if (isValidName(name)) return name;

  res.status(400).send('Invalid instance name');
  return undefined;
}
