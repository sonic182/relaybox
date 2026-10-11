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

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originHost(origin: string): string | undefined {
  return URL.canParse(origin) ? new URL(origin).host : undefined;
}

export function isSameOriginRequest(req: Request): boolean {
  const site = req.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'none';

  const origin = req.get('origin');
  return origin === undefined || originHost(origin) === req.get('host');
}

export function requireSameOrigin(req: Request, res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method) || isSameOriginRequest(req)) return next();
  res.status(403).send('Cross-origin request rejected');
}
