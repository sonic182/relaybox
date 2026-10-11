import type { NextFunction, Request, Response } from 'express';
import { secretEquals } from '../auth';
import { API_KEY } from '../config';
import { unauthorized } from './errors';

/** Reference header name is `apikey`; see evolution-api/src/api/guards/auth.guard.ts. */
export function requireApiKey(req: Request, _res: Response, next: NextFunction): void {
  if (secretEquals(req.get('apikey'), API_KEY)) return next();
  next(unauthorized());
}
