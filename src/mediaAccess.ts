import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { API_KEY, MCP_MEDIA_BASE_URL, MCP_MEDIA_URL_TTL } from './config';
import { MEDIA_DIR } from './instances';

/** Resolves a stored media path inside the instance's directory, or undefined when it is missing. */
export function resolveStoredMediaPath(instanceName: string, path: string): string | undefined {
  const directory = resolve(MEDIA_DIR, instanceName);
  const file = resolve(directory, path);
  return file.startsWith(directory + sep) && existsSync(file) ? file : undefined;
}

/** HMAC over the instance, message id, and expiry, keyed by the app's single credential. */
function signature(instanceName: string, keyId: string, exp: number): string {
  return createHmac('sha256', API_KEY).update(`${instanceName}:${keyId}:${exp}`).digest('hex');
}

/**
 * Verifies a signed media token. Expiry is checked first so a stale token never reaches the
 * constant-time comparison, and the comparison itself is length-safe.
 */
export function verifyMediaSignature(
  instanceName: string,
  keyId: string,
  exp: string | undefined,
  sig: string | undefined,
): boolean {
  const expiry = Number(exp);
  if (!exp || !sig || !Number.isInteger(expiry) || expiry * 1000 < Date.now()) return false;
  const expected = Buffer.from(signature(instanceName, keyId, expiry));
  const provided = Buffer.from(sig);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

/** A short-lived URL any caller can fetch without the API key, for media a tool refers to. */
export function buildMediaUrl(instanceName: string, keyId: string, now = Date.now()): { url: string; expiresAt: string } {
  const exp = Math.floor(now / 1000) + MCP_MEDIA_URL_TTL;
  const url = new URL(`/media/${encodeURIComponent(instanceName)}/${encodeURIComponent(keyId)}`, MCP_MEDIA_BASE_URL);
  url.searchParams.set('exp', String(exp));
  url.searchParams.set('sig', signature(instanceName, keyId, exp));
  return { url: url.href, expiresAt: new Date(exp * 1000).toISOString() };
}
