import { parseLogFormat, parseLogLevel } from './logger';
import { isLoopbackHost, isPrivateHost } from './net';

export function parsePositiveInt(name: string, value: string | undefined, fallback: number): number {
  const parsed = Number(value?.trim() || fallback);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);

  return parsed;
}

/** Like {@link parsePositiveInt}, but zero is allowed (an inline cap of zero disables the feature). */
export function parseNonNegativeInt(name: string, value: string | undefined, fallback: number): number {
  const parsed = Number(value?.trim() || fallback);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);

  return parsed;
}

try {
  process.loadEnvFile();
} catch {
  // no .env file, rely on process env
}

export const MIN_API_KEY_LENGTH = 16;
const PLACEHOLDER_API_KEYS = new Set(['changeme-api-key']);

export function parseApiKey(value: string | undefined): string {
  if (!value) throw new Error('API_KEY env var is required');
  if (PLACEHOLDER_API_KEYS.has(value)) throw new Error('API_KEY must not be the .env.example placeholder');
  if (value.length < MIN_API_KEY_LENGTH) {
    throw new Error(`API_KEY must be at least ${MIN_API_KEY_LENGTH} characters`);
  }

  return value;
}

/** The single credential: the `apikey` header for the JSON API, and the dashboard login. */
export const API_KEY = parseApiKey(process.env.API_KEY);

/** Minimum severity emitted by the application logger. */
export const LOG_LEVEL = parseLogLevel(process.env.LOG_LEVEL);

/** Console log encoding; files remain JSON. */
export const LOG_FORMAT = parseLogFormat(process.env.LOG_FORMAT);

/** Optional directory for a JSON application log in addition to stdout. */
export const LOG_DIRECTORY = process.env.LOG_DIRECTORY?.trim() || undefined;

/**
 * Development allows any http(s) callback URL. Outside development the policy is
 * https only, except http on loopback, and never a private or link-local host.
 */
export const ALLOW_INSECURE_WEBHOOK_URLS = process.env.NODE_ENV !== 'production';

/**
 * Opt in to webhook targets on the local network (RFC 1918, IPv6 unique-local, `.local`
 * and `.internal` names), over plain http. Off by default: the guard exists so a stolen
 * API key cannot turn the server into a probe of the network it sits in, and only the
 * operator knows whether their consumer really lives on the LAN.
 *
 * Link-local stays blocked either way — that is where cloud instance metadata lives.
 */
export const ALLOW_PRIVATE_WEBHOOK_TARGETS = ['true', '1'].includes(
  (process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS ?? '').trim().toLowerCase(),
);

export function parseTrustProxy(value: string | undefined): boolean | number | string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed === 'true' || trimmed === 'false') return trimmed === 'true';
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  return trimmed;
}

export const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);

export const SERVER_URL = process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

/** How many due webhook deliveries one drain sends at once. */
export const DELIVERY_CONCURRENCY = parsePositiveInt('DELIVERY_CONCURRENCY', process.env.DELIVERY_CONCURRENCY, 4);

export const DB_URL = process.env.DB_URL;
if (!DB_URL) {
  throw new Error('DB_URL env var is required');
}

/** Cap on outbound media bytes, whether fetched from a URL or decoded from base64. */
export const MAX_OUTBOUND_MEDIA_BYTES = parsePositiveInt(
  'MAX_OUTBOUND_MEDIA_BYTES',
  process.env.MAX_OUTBOUND_MEDIA_BYTES,
  20 * 1024 * 1024,
);

/**
 * Opt in to the authenticated MCP server. Deliberately separate from `ENABLE_DEV_MCP`, which
 * gates the unauthenticated, code-executing dev server in `src/dev-mcp.ts`.
 */
export const ENABLE_MCP_SERVER = ['true', '1'].includes(
  (process.env.ENABLE_MCP_SERVER ?? '').trim().toLowerCase(),
);

/** Namespaces owned by existing HTTP routes, which are mounted before MCP. */
const RESERVED_MCP_NAMESPACES = new Set([
  'instance', 'message', 'webhook', 'chat', 'instances', 'media',
  'dashboard', 'login', 'logout', 'redoc', 'ui', 'dev',
]);

/** Where the MCP server is mounted. Kept clear of existing HTTP route namespaces. */
export function parseMcpPath(value: string | undefined): string {
  const path = value?.trim() || '/mcp';
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(path) || RESERVED_MCP_NAMESPACES.has(path.split('/')[1].toLowerCase())) {
    throw new Error('MCP_PATH must be a non-root literal path without a trailing slash, outside reserved HTTP route namespaces');
  }
  return path;
}

export const MCP_PATH = parseMcpPath(process.env.MCP_PATH);

/** Hostnames allowed to reach the MCP endpoint when it is not bound to localhost. */
export const MCP_ALLOWED_HOSTS = (process.env.MCP_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

/** Largest inline base64 payload an MCP media tool accepts or returns; 0 disables inline media. */
export const MCP_INLINE_MEDIA_BYTES = parseNonNegativeInt(
  'MCP_INLINE_MEDIA_BYTES',
  process.env.MCP_INLINE_MEDIA_BYTES,
  1024 * 1024,
);

/** Base URL of the signed media links the MCP server returns; defaults to `SERVER_URL`. */
export const MCP_MEDIA_BASE_URL = process.env.MCP_MEDIA_BASE_URL?.trim() || SERVER_URL;

/** Lifetime of a signed media URL handed out by the MCP server. */
export const MCP_MEDIA_URL_TTL = parsePositiveInt('MCP_MEDIA_URL_TTL', process.env.MCP_MEDIA_URL_TTL, 300);

export type RemoteTarget = { url: URL; token: string };

/**
 * Outbound control socket. A bad value disables the feature instead of crashing, since a
 * dashboard that still works is more use than a process that refuses to boot.
 *
 * Unlike the webhook target policy, private targets are allowed: the URL comes from the
 * operator, not from an API caller, so it is not an SSRF boundary. Public hosts must use wss://.
 */
export function parseRemoteTarget(
  rawUrl: string | undefined,
  rawToken: string | undefined,
): { target?: RemoteTarget; error?: string } {
  const value = rawUrl?.trim();
  const token = rawToken?.trim();
  if (!value) {
    if (!token) return {};

    return { error: 'REMOTE_SERVER_TOKEN is set without REMOTE_SERVER_URL' };
  }
  if (!URL.canParse(value)) return { error: 'REMOTE_SERVER_URL is not a valid URL' };

  const url = new URL(value);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return { error: 'REMOTE_SERVER_URL must use ws:// or wss://' };
  // Userinfo would be sent as a second, unasked-for credential on the upgrade, and any log
  // of the href would print it. The token is the only credential, and it travels in a header.
  if (url.username || url.password) return { error: 'REMOTE_SERVER_URL must not contain credentials; use REMOTE_SERVER_TOKEN' };
  // `ws` throws synchronously on a fragment, and one of the two callers is a timer with no
  // frame to catch it. Rejecting here keeps the promise that a bad value only disables the feature.
  if (url.hash) return { error: 'REMOTE_SERVER_URL must not contain a fragment' };
  if (!token) return { error: 'REMOTE_SERVER_TOKEN is required when REMOTE_SERVER_URL is set' };

  // The socket carries control frames that can delete instances and redirect webhooks, so an
  // on-path attacker must not be able to read the token or inject frames.
  const insecure = url.protocol === 'ws:' && !isLoopbackHost(url.hostname) && !isPrivateHost(url.hostname);
  if (insecure) return { error: `REMOTE_SERVER_URL must use wss:// for ${url.hostname}` };

  return { target: { url, token } };
}

/** Holds the token in plaintext: never log this object whole. */
export const REMOTE_TARGET = parseRemoteTarget(process.env.REMOTE_SERVER_URL, process.env.REMOTE_SERVER_TOKEN);
