import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { API_KEY } from './config';

export const COOKIE_NAME = 'relaybox_session';
export const LEGACY_COOKIE_NAME = 'api_key';

/** Length-safe, constant-time secret comparison shared by the dashboard cookie and the API key. */
export function secretEquals(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isValidToken(candidate: string | undefined): boolean {
  return secretEquals(candidate, API_KEY);
}

export function sessionToken(): string {
  return createHmac('sha256', API_KEY).update('dashboard-session').digest('hex');
}

export function isValidSession(candidate: string | undefined): boolean {
  return secretEquals(candidate, sessionToken());
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (isValidSession(req.cookies?.[COOKIE_NAME])) return next();
  res.redirect('/login');
}
