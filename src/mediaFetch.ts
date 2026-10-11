import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { isForbiddenHostname, isForbiddenIp } from './net';

/** Media the caller supplied that we will not send: unreadable, unreachable, or too large. */
export class InvalidMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMediaError';
  }
}

export type MediaFetchRequest = {
  url: URL;
  address: string;
  timeoutMs: number;
};

export type MediaFetchResponse = {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
};

export type MediaFetchRequestImpl = (request: MediaFetchRequest) => Promise<MediaFetchResponse>;

export type FetchedMedia = {
  buffer: Buffer;
  /** The response's `content-type` header, verbatim. */
  contentType?: string;
};

/** What `sendMedia` resolves a `media` string to; `url` is set only when it was fetched. */
export type ResolvedMedia = FetchedMedia & { url?: string };

export type FetchRemoteMediaOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  resolveHost?: (hostname: string) => Promise<string[]>;
  requestImpl?: MediaFetchRequestImpl;
};

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const addresses = await dnsLookup(hostname, { all: true });
  return addresses.map((address) => address.address);
}

function responseHeaders(headers: Record<string, string | string[] | undefined>): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) result.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return result;
}

function defaultRequest({ url, address, timeoutMs }: MediaFetchRequest): Promise<MediaFetchResponse> {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const options = {
      method: 'GET',
      autoSelectFamily: false,
      lookup: (_hostname: string, _options: unknown, callback: (err: null, address: string, family: number) => void) =>
        callback(null, address, isIP(address)),
    };
    const req = request(
      url,
      options,
      (response) => {
        response.once('end', () => clearTimeout(timeout));
        response.once('error', () => clearTimeout(timeout));
        resolve({
          status: response.statusCode ?? 0,
          headers: responseHeaders(response.headers),
          body: Readable.toWeb(response) as ReadableStream<Uint8Array>,
        });
      },
    );
    const timeout = setTimeout(() => req.destroy(new Error(`media request timed out after ${timeoutMs}ms`)), timeoutMs);
    timeout.unref();
    req.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    req.end();
  });
}

/**
 * Fetches media bytes an API caller pointed us at by URL through the checked DNS address.
 */
export async function fetchRemoteMedia(
  url: string,
  {
    timeoutMs = 10_000,
    maxBytes = 20 * 1024 * 1024,
    resolveHost = defaultResolveHost,
    requestImpl = defaultRequest,
  }: FetchRemoteMediaOptions = {},
): Promise<FetchedMedia> {
  const target = new URL(url);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`unsupported media url protocol: ${target.protocol}`);
  }

  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  if (isForbiddenHostname(hostname)) {
    throw new Error(`refusing to fetch media from a private or reserved host (${hostname})`);
  }

  const literal = /^[\d.]+$/.test(hostname) || hostname.includes(':');
  const addresses = literal ? [hostname] : await resolveHost(hostname);
  if (!addresses.length) throw new Error('refusing to fetch media from a hostname with no resolved addresses');
  for (const address of addresses) {
    if (isForbiddenIp(address)) throw new Error(`refusing to fetch media from a private address (${address})`);
  }

  const response = await requestImpl({ url: target, address: addresses[0]!, timeoutMs });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`refusing to follow a redirect fetching media (status ${response.status})`);
  }
  if (response.status < 200 || response.status >= 300) throw new Error(`media fetch failed with status ${response.status}`);

  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`media exceeds the ${maxBytes}-byte limit`);
  }

  const contentType = response.headers.get('content-type') ?? undefined;
  if (!response.body) return { buffer: Buffer.alloc(0), contentType };

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`media exceeds the ${maxBytes}-byte limit`);
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return { buffer: Buffer.concat(chunks), contentType };
}
