import { createHmac } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { Logger } from 'pino';
import { ALLOW_INSECURE_WEBHOOK_URLS, ALLOW_PRIVATE_WEBHOOK_TARGETS } from './config';
import type { Db } from './db';
import { isForbiddenIp, isLoopbackHost } from './net';
import type { DeliveryHandler, DeliveryJob, DeliveryOutcome, DeliveryQueue } from './queue';

export type DeliveryRequest = {
  url: URL;
  headers: Record<string, string>;
  body: string;
  /** A DNS result validated immediately before this connection, when required. */
  address?: string;
  timeoutMs: number;
};

/** `X-Webhook-Signature` value: the HMAC-SHA256 of the raw body, GitHub-webhook style. */
export function signWebhookBody(body: string, secret: string): string {
  const digest = createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${digest}`;
}

export type DeliveryRequestImpl = (request: DeliveryRequest) => Promise<{ status: number }>;

export type DeliveryHandlerOptions = {
  db: Db;
  logger: Logger;
  /** Injectable so tests never open a socket. */
  requestImpl?: DeliveryRequestImpl;
  resolveHost?: (hostname: string) => Promise<string[]>;
  allowInsecureUrls?: boolean;
  allowPrivateTargets?: boolean;
  timeoutMs?: number;
};

/**
 * 4xx means the consumer rejected the payload and will keep rejecting it. 408 and 429
 * are the exceptions: they say "later", not "never".
 */
export function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  return status < 400 || status >= 500;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const addresses = await dnsLookup(hostname, { all: true });
  return addresses.map((address) => address.address);
}

/** Connects through the validated address while retaining the URL hostname for TLS/SNI. */
function defaultRequest({ url, headers, body, address, timeoutMs }: DeliveryRequest): Promise<{ status: number }> {
  const request = url.protocol === 'https:' ? httpsRequest : url.protocol === 'http:' ? httpRequest : undefined;
  if (!request) return Promise.reject(new Error(`unsupported webhook protocol: ${url.protocol}`));

  return new Promise((resolve, reject) => {
    // Node's Happy Eyeballs (autoSelectFamily) calls `lookup` with `all: true` and expects
    // an array back; our lookup only ever returns one pinned address. `autoSelectFamily`
    // isn't in @types/node's RequestOptions, so build the object before passing it in.
    const options = {
      method: 'POST',
      headers,
      autoSelectFamily: false,
      lookup: address
        ? (_hostname: string, _options: unknown, callback: (err: null, address: string, family: number) => void) =>
          callback(null, address, isIP(address))
        : undefined,
    };
    const req = request(
      url,
      options,
      (response) => {
        clearTimeout(timeout);
        response.resume();
        resolve({ status: response.statusCode ?? 0 });
      },
    );
    const timeout = setTimeout(() => req.destroy(new Error(`webhook request timed out after ${timeoutMs}ms`)), timeoutMs);
    timeout.unref();
    req.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    req.end(body);
  });
}

/**
 * Performs one webhook delivery. Knows nothing about scheduling or retries; it reports an
 * outcome and the queue decides what happens next.
 */
export function createDeliveryHandler({
  db,
  logger,
  requestImpl = defaultRequest,
  resolveHost = defaultResolveHost,
  allowInsecureUrls = ALLOW_INSECURE_WEBHOOK_URLS,
  allowPrivateTargets = ALLOW_PRIVATE_WEBHOOK_TARGETS,
  timeoutMs = 10_000,
}: DeliveryHandlerOptions): DeliveryHandler {
  /**
     * The configuration-time hostname check cannot see where a name resolves. Pin the
     * connection to a checked address so a second DNS lookup cannot rebind it privately.
     */
  async function resolveTarget(url: URL): Promise<string | undefined> {
    if (allowInsecureUrls) return undefined;

    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    // Production deliberately permits a loopback callback (the only allowed HTTP
    // exception), so do not reject its expected loopback resolution here.
    if (isLoopbackHost(hostname)) return undefined;

    const literal = /^[\d.]+$/.test(hostname) || hostname.includes(':');
    const addresses = literal ? [hostname] : await resolveHost(hostname);
    if (!addresses.length) throw new Error('refusing to deliver to a hostname with no resolved addresses');

    for (const address of addresses) {
      if (isForbiddenIp(address, allowPrivateTargets)) {
        throw new Error(`refusing to deliver to a private address (${address})`);
      }
    }

    return addresses[0];
  }

  return async function deliver(job: DeliveryJob): Promise<DeliveryOutcome> {
    const config = await db.webhookConfig.findUnique({ where: { instanceId: job.instanceId } });
    // Headers and the signing secret live only on the configuration, never in the queued
    // job, so a rotated secret applies to deliveries that are still pending.
    const configured = (config?.headers as Record<string, string> | null) ?? {};
    const signatureSecret = config?.signatureSecret ?? undefined;
    const signatureEnabled = config?.signatureEnabled ?? Boolean(signatureSecret);

    let status: number;
    try {
      const url = new URL(job.url);
      // Sign the exact bytes that go on the wire, so a consumer can verify them verbatim.
      const body = JSON.stringify(job.payload);
      status = (
        await requestImpl({
          url,
          address: await resolveTarget(url),
          timeoutMs,
          headers: {
            ...configured,
            'content-type': 'application/json',
            'x-delivery-id': job.id,
            'x-event-type': job.event,
            ...(signatureEnabled && signatureSecret ? { 'x-webhook-signature': signWebhookBody(body, signatureSecret) } : {}),
          },
          body,
        })
      ).status;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // A refused target is a configuration problem, not a transient one.
      const retryable = !error.startsWith('refusing to');
      logger.warn({ err, deliveryId: job.id, event: job.event }, 'webhook delivery failed');
      return { status: 'failed', error, retryable };
    }

    if (status >= 300 && status < 400) {
      logger.warn({ deliveryId: job.id, status }, 'webhook delivery redirected');
      return {
        status: 'failed',
        responseStatus: status,
        error: `refusing to follow a redirect (${status})`,
        retryable: false,
      };
    }

    if (status < 200 || status >= 300) {
      logger.warn({ deliveryId: job.id, status }, 'webhook consumer rejected the delivery');
      return {
        status: 'failed',
        responseStatus: status,
        error: `consumer responded ${status}`,
        retryable: isRetryableStatus(status),
      };
    }

    logger.info({ deliveryId: job.id, event: job.event, status }, 'webhook delivered');
    return { status: 'delivered', responseStatus: status };
  };
}

/** Wires the handler to a queue. Swapping the queue swaps the transport, nothing else. */
export function createDeliveryWorker({ queue, ...options }: DeliveryHandlerOptions & { queue: DeliveryQueue }) {
  const handler = createDeliveryHandler(options);
  let stop: (() => Promise<void>) | undefined;

  return {
    handler,
    start(): void {
      stop ??= queue.consume(handler);
    },
    /** Resolves once an in-flight delivery attempt has settled. */
    async stop(): Promise<void> {
      await stop?.();
      stop = undefined;
    },
  };
}
