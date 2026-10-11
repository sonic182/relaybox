import type { Request, Response } from 'express';
import { COOKIE_NAME, LEGACY_COOKIE_NAME, isValidSession, isValidToken, sessionToken } from '../auth';
import { SESSION_TTL_SECONDS } from '../config';
import { loginError, loginPage, loginThrottled } from '../views';

export function home(req: Request, res: Response): void {
  res.redirect(isValidSession(req.cookies?.[COOKIE_NAME]) ? '/dashboard' : '/login');
}

export function showLogin(_req: Request, res: Response): void {
  res.send(loginPage());
}

export function login(req: Request, res: Response): void {
  if (!isValidToken(req.body?.token)) {
    res.send(loginError());
    return;
  }

  res.clearCookie(LEGACY_COOKIE_NAME);
  res.cookie(COOKIE_NAME, sessionToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
  res.set('HX-Redirect', '/dashboard').end();
}

export function logout(_req: Request, res: Response): void {
  res.clearCookie(COOKIE_NAME);
  res.clearCookie(LEGACY_COOKIE_NAME);
  res.set('HX-Redirect', '/login').end();
}

export function tooManyLogins(_req: Request, res: Response): void {
  res.status(429).send(loginThrottled());
}
