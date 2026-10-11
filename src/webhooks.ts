import { DbNull } from '@zenstackhq/orm';
import { ALLOW_INSECURE_WEBHOOK_URLS, ALLOW_PRIVATE_WEBHOOK_TARGETS } from './config';
import { isForbiddenHostname, isLoopbackHost, isPrivateHost } from './net';
import {
  SUPPORTED_EVENTS,
  isSupportedEvent,
  type EvolutionEvent,
  type WebhookConfigResponse,
} from './contracts/evolution';
import type { Db } from './db';

export class WebhookValidationError extends Error {
  readonly messages: string[];

  constructor(messages: string[]) {
    super(messages.join(', '));
    this.name = 'WebhookValidationError';
    this.messages = messages;
  }
}

export class InstanceNotFoundError extends Error {
  readonly instanceName: string;

  constructor(instanceName: string) {
    super(`Instance "${instanceName}" not found`);
    this.name = 'InstanceNotFoundError';
    this.instanceName = instanceName;
  }
}

const MAX_HEADERS = 20;
const MAX_HEADER_VALUE = 2048;
const MIN_SIGNATURE_SECRET_LENGTH = 16;
const MAX_SIGNATURE_SECRET_LENGTH = 512;
// RFC 7230 header field name.
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Development accepts any http(s) callback. Otherwise: https, never a loopback, private
 * or link-local host, and http only to loopback or private hosts once those are allowed.
 *
 * Hostname-only check: a public name that resolves to a private address still passes
 * here, which is why the delivery worker re-checks the resolved address (src/delivery.ts).
 */
export function validateCallbackUrl(
  raw: unknown,
  allowInsecure = ALLOW_INSECURE_WEBHOOK_URLS,
  allowPrivate = ALLOW_PRIVATE_WEBHOOK_TARGETS,
): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return ['"url" is required'];

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return ['"url" must be an absolute URL'];
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return ['"url" must use http or https'];
  if (allowInsecure) return [];

  // A consumer on the LAN has no public name to get a certificate for, so opting into
  // private targets has to permit plain http to them as well.
  const plaintextAllowed = allowPrivate && (isLoopbackHost(url.hostname) || isPrivateHost(url.hostname));
  if (url.protocol === 'http:' && !plaintextAllowed) {
    return ['"url" must use https outside local development'];
  }
  if (isForbiddenHostname(url.hostname, allowPrivate)) {
    return [
      allowPrivate
        ? '"url" must not target a link-local address'
        : '"url" must not target a private, loopback or link-local address',
    ];
  }

  return [];
}

export type ParsedWebhookConfig = {
  url: string;
  /** `undefined` keeps the stored headers; `null` clears them. */
  headers: Record<string, string> | null | undefined;
  /** `undefined` keeps the stored secret; `null` (or empty) disables signing. */
  signatureSecret: string | null | undefined;
  /** `undefined` preserves the current delivery-signing setting. */
  signatureEnabled: boolean | undefined;
  enabled: boolean;
  events: EvolutionEvent[];
  webhookByEvents: boolean;
  webhookBase64: boolean;
};

function parseHeaders(raw: unknown, errors: string[]): Record<string, string> | null | undefined {
  // Omitted means "leave the stored headers alone", as in the reference; null clears them.
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('"headers" must be an object of string values');
    return null;
  }

  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_HEADERS) errors.push(`"headers" accepts at most ${MAX_HEADERS} entries`);

  const headers: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!HEADER_NAME.test(name)) {
      errors.push(`"headers" contains an invalid header name: ${name}`);
    } else if (typeof value !== 'string' || value.length > MAX_HEADER_VALUE) {
      errors.push(`"headers.${name}" must be a string of at most ${MAX_HEADER_VALUE} characters`);
    } else {
      headers[name] = value;
    }
  }

  return headers;
}

function parseSignatureSecret(raw: unknown, errors: string[]): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string') {
    errors.push('"signatureSecret" must be a string');
    return undefined;
  }
  const secret = raw.trim();
  if (secret.length && secret.length < MIN_SIGNATURE_SECRET_LENGTH) {
    errors.push(`"signatureSecret" must be at least ${MIN_SIGNATURE_SECRET_LENGTH} characters`);
    return undefined;
  }
  if (secret.length > MAX_SIGNATURE_SECRET_LENGTH) {
    errors.push(`"signatureSecret" must be at most ${MAX_SIGNATURE_SECRET_LENGTH} characters`);
    return undefined;
  }
  // Empty means the same as null: explicitly turn signing off.
  return secret || null;
}

function parseSignatureEnabled(raw: unknown, errors: string[]): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'boolean') {
    errors.push('"signatureEnabled" must be a boolean');
    return undefined;
  }
  return raw;
}

function parseEvents(raw: unknown, errors: string[]): EvolutionEvent[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push('"events" must be an array');
    return [];
  }

  const unsupported = raw.filter((event) => !isSupportedEvent(event));
  if (unsupported.length) {
    errors.push(`unsupported events: ${unsupported.join(', ')}`);
    return [];
  }

  return raw as EvolutionEvent[];
}

/** Validates the reference request body and applies its event defaulting rules. */
export function parseWebhookConfig(
  body: unknown,
  allowInsecure = ALLOW_INSECURE_WEBHOOK_URLS,
  allowPrivate = ALLOW_PRIVATE_WEBHOOK_TARGETS,
): ParsedWebhookConfig {
  const webhook = (body as { webhook?: unknown } | null)?.webhook;
  if (!webhook || typeof webhook !== 'object' || Array.isArray(webhook)) {
    throw new WebhookValidationError(['"webhook" must be an object']);
  }

  const input = webhook as Record<string, unknown>;
  const errors: string[] = [];

  const enabled = input.enabled ?? true;
  if (typeof enabled !== 'boolean') errors.push('"enabled" must be a boolean');

  const byEvents = input.byEvents ?? false;
  if (typeof byEvents !== 'boolean') errors.push('"byEvents" must be a boolean');

  const base64 = input.base64 ?? false;
  if (typeof base64 !== 'boolean') errors.push('"base64" must be a boolean');

  errors.push(...validateCallbackUrl(input.url, allowInsecure, allowPrivate));
  const headers = parseHeaders(input.headers, errors);
  const signatureSecret = parseSignatureSecret(input.signatureSecret, errors);
  const signatureEnabled = parseSignatureEnabled(input.signatureEnabled, errors);
  let events = parseEvents(input.events, errors);

  if (errors.length) throw new WebhookValidationError(errors);

  // Reference behavior: disabling clears the selection, and enabling with an empty
  // selection subscribes to every reference event. Project extensions remain opt-in.
  if (!enabled) events = [];
  else if (!events.length) events = [...SUPPORTED_EVENTS];

  return {
    url: (input.url as string).trim(),
    headers,
    signatureSecret,
    signatureEnabled,
    enabled: enabled as boolean,
    events,
    webhookByEvents: byEvents as boolean,
    webhookBase64: base64 as boolean,
  };
}

type WebhookRow = {
  id: string;
  url: string;
  headers: unknown;
  signatureSecret: string | null;
  signatureEnabled: boolean;
  enabled: boolean;
  events: unknown;
  webhookByEvents: boolean;
  webhookBase64: boolean;
  createdAt: Date;
  updatedAt: Date;
  instanceId: string;
};

function toResponse(row: WebhookRow): WebhookConfigResponse {
  return {
    id: row.id,
    url: row.url,
    headers: (row.headers as Record<string, string> | null) ?? null,
    hasSignatureSecret: row.signatureSecret !== null,
    signatureEnabled: row.signatureEnabled,
    enabled: row.enabled,
    events: (row.events as EvolutionEvent[]) ?? [],
    webhookByEvents: row.webhookByEvents,
    webhookBase64: row.webhookBase64,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    instanceId: row.instanceId,
  };
}

/**
 * One delivery attempt as the dashboard shows it. Deliberately not the stored row: the
 * payload is left out because it carries message content and the envelope's `apikey`, and
 * neither belongs on a history screen.
 */
export type DeliveryHistoryEntry = {
  id: string;
  event: string;
  status: string;
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
  nextAttemptAt: Date | null;
};

export type WebhookService = {
  /** Null when the instance is unknown or has no configuration, matching the reference. */
  getWebhook(instanceName: string): Promise<WebhookConfigResponse | null>;
  validateWebhook(body: unknown, options?: { allowStoredSecret?: boolean }): void;
  setWebhook(instanceName: string, body: unknown): Promise<WebhookConfigResponse>;
  /**
     * The reference read response cannot distinguish an unknown instance from an
     * unconfigured one, so callers that must (the dashboard) ask separately.
     */
  instanceExists(instanceName: string): Promise<boolean>;
  /** Most recent delivery attempts first; empty for an unknown instance. */
  listDeliveries(instanceName: string, limit?: number): Promise<DeliveryHistoryEntry[]>;
};

type WebhookServiceOptions = {
  db: Db;
  allowInsecureUrls?: boolean;
  allowPrivateTargets?: boolean;
};

export function createWebhookService({
  db,
  allowInsecureUrls = ALLOW_INSECURE_WEBHOOK_URLS,
  allowPrivateTargets = ALLOW_PRIVATE_WEBHOOK_TARGETS,
}: WebhookServiceOptions): WebhookService {
  const resolveSignatureConfig = (
    config: ParsedWebhookConfig,
    existing: { signatureSecret: string | null; signatureEnabled: boolean } | null = null,
  ) => {
    const signatureSecret = config.signatureSecret === undefined ? (existing?.signatureSecret ?? null) : config.signatureSecret;
    const signatureEnabled =
      config.signatureEnabled ??
      (config.signatureSecret === undefined ? (existing?.signatureEnabled ?? Boolean(existing?.signatureSecret)) : signatureSecret !== null);

    if (signatureEnabled && !signatureSecret) {
      throw new WebhookValidationError(['"signatureSecret" is required when "signatureEnabled" is true']);
    }

    return { signatureSecret, signatureEnabled };
  };

  return {
    async instanceExists(instanceName) {
      return (await db.instanceRecord.count({ where: { name: instanceName } })) > 0;
    },

    async listDeliveries(instanceName, limit = 20) {
      const instance = await db.instanceRecord.findUnique({ where: { name: instanceName } });
      if (!instance) return [];

      return db.webhookDelivery.findMany({
        where: { instanceId: instance.id },
        // Selected explicitly so the payload and the per-delivery url, which can
        // carry a token in its path, never reach a caller by accident.
        select: {
          id: true,
          event: true,
          status: true,
          attempts: true,
          responseStatus: true,
          lastError: true,
          createdAt: true,
          deliveredAt: true,
          nextAttemptAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
    },

    async getWebhook(instanceName) {
      const instance = await db.instanceRecord.findUnique({ where: { name: instanceName } });
      if (!instance) return null;

      const row = await db.webhookConfig.findUnique({ where: { instanceId: instance.id } });
      return row ? toResponse(row) : null;
    },

    validateWebhook(body, { allowStoredSecret = false } = {}) {
      const config = parseWebhookConfig(body, allowInsecureUrls, allowPrivateTargets);
      if (!allowStoredSecret) resolveSignatureConfig(config);
    },

    async setWebhook(instanceName, body) {
      const instance = await db.instanceRecord.findUnique({ where: { name: instanceName } });
      if (!instance) throw new InstanceNotFoundError(instanceName);

      const existing = await db.webhookConfig.findUnique({ where: { instanceId: instance.id } });
      const config = parseWebhookConfig(
        body,
        allowInsecureUrls,
        allowPrivateTargets,
      );
      const { headers, ...rest } = config;
      const { signatureSecret, signatureEnabled } = resolveSignatureConfig(config, existing);

      const row = await db.webhookConfig.upsert({
        where: { instanceId: instance.id },
        // A nullable Json column is cleared with the DbNull sentinel, not `null`.
        create: { instanceId: instance.id, ...rest, signatureSecret, signatureEnabled, headers: headers ?? DbNull },
        update:
          headers === undefined
            ? { ...rest, signatureSecret, signatureEnabled }
            : { ...rest, signatureSecret, signatureEnabled, headers: headers ?? DbNull },
      });

      return toResponse(row);
    },
  };
}
