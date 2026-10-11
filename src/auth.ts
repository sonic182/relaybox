import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { API_KEY, SESSION_TTL_SECONDS } from './config';

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

const CLOCK_SKEW_MS = 60_000;

function sessionSignature(issuedAt: string): string {
  return createHmac('sha256', API_KEY).update(`dashboard-session:${issuedAt}`).digest('hex');
}

export function sessionToken(issuedAt = Date.now()): string {
  return `${issuedAt}.${sessionSignature(String(issuedAt))}`;
}

export function isValidSession(candidate: string | undefined, now = Date.now()): boolean {
  const match = /^(\d{1,15})\.([0-9a-f]{64})$/.exec(candidate ?? '');
  if (!match) return false;

  const issuedAt = Number(match[1]);
  if (issuedAt > now + CLOCK_SKEW_MS || now - issuedAt >= SESSION_TTL_SECONDS * 1000) return false;

  return secretEquals(match[2], sessionSignature(match[1]));
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
