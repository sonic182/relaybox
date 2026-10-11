import { describe, expect, it, vi } from 'vitest';
import { fetchRemoteMedia, type MediaFetchResponse } from '../../src/mediaFetch';

function fakeRequest(response: Partial<MediaFetchResponse> = {}) {
  return vi.fn().mockResolvedValue({ status: 200, headers: new Headers(), body: null, ...response });
}

function bodyOf(bytes: Uint8Array<ArrayBuffer>): NonNullable<Response['body']> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }) as NonNullable<Response['body']>;
}

describe('fetchRemoteMedia', () => {
  it('rejects a private address the hostname resolves to', async () => {
    const requestImpl = fakeRequest();

    await expect(
      fetchRemoteMedia('https://internal.example/file.png', {
        resolveHost: async () => ['10.0.0.5'],
        requestImpl,
      }),
    ).rejects.toThrow('private address');
    expect(requestImpl).not.toHaveBeenCalled();
  });

  it('rejects a loopback or reserved hostname outright', async () => {
    const requestImpl = fakeRequest();

    await expect(fetchRemoteMedia('http://localhost/file.png', { requestImpl })).rejects.toThrow(
      'private or reserved host',
    );
    await expect(fetchRemoteMedia('http://service.internal/file.png', { requestImpl })).rejects.toThrow(
      'private or reserved host',
    );
    expect(requestImpl).not.toHaveBeenCalled();
  });

  it('rejects an unsupported protocol', async () => {
    await expect(fetchRemoteMedia('file:///etc/passwd')).rejects.toThrow('unsupported media url protocol');
  });

  it('refuses to follow a redirect', async () => {
    const requestImpl = fakeRequest({ status: 302 });

    await expect(
      fetchRemoteMedia('https://consumer.example/file.png', { resolveHost: async () => ['1.1.1.1'], requestImpl }),
    ).rejects.toThrow('refusing to follow a redirect');
  });

  it('rejects a response over the size cap via Content-Length', async () => {
    const requestImpl = fakeRequest({ headers: new Headers({ 'content-length': String(2000) }) });

    await expect(
      fetchRemoteMedia('https://consumer.example/file.png', {
        resolveHost: async () => ['1.1.1.1'],
        requestImpl,
        maxBytes: 1000,
      }),
    ).rejects.toThrow('exceeds the 1000-byte limit');
  });

  it('rejects a streamed body that exceeds the cap even without Content-Length', async () => {
    const requestImpl = fakeRequest({ body: bodyOf(new Uint8Array(2000)) });

    await expect(
      fetchRemoteMedia('https://consumer.example/file.png', {
        resolveHost: async () => ['1.1.1.1'],
        requestImpl,
        maxBytes: 1000,
      }),
    ).rejects.toThrow('exceeds the 1000-byte limit');
  });

  it('returns the fetched bytes for a public target', async () => {
    const payload = new TextEncoder().encode('hello media');
    const requestImpl = fakeRequest({ body: bodyOf(payload) });

    const { buffer, contentType } = await fetchRemoteMedia('https://consumer.example/file.png', {
      resolveHost: async () => ['1.1.1.1'],
      requestImpl,
    });

    expect(buffer.toString()).toBe('hello media');
    expect(contentType).toBeUndefined();
  });

  it('returns the response content-type alongside the bytes', async () => {
    const requestImpl = fakeRequest({ headers: new Headers({ 'content-type': 'application/pdf' }), body: bodyOf(new Uint8Array(1)) });

    const { contentType } = await fetchRemoteMedia('https://consumer.example/download', {
      resolveHost: async () => ['1.1.1.1'],
      requestImpl,
    });

    expect(contentType).toBe('application/pdf');
  });

  it('accepts a literal public IP address without a DNS lookup', async () => {
    const resolveHost = vi.fn();
    const requestImpl = fakeRequest({ body: bodyOf(new TextEncoder().encode('ok')) });

    await fetchRemoteMedia('https://1.1.1.1/file.png', { resolveHost, requestImpl });

    expect(resolveHost).not.toHaveBeenCalled();
  });

  it('connects through the checked address instead of resolving the hostname again', async () => {
    const requestImpl = fakeRequest({ body: bodyOf(new TextEncoder().encode('ok')) });

    await fetchRemoteMedia('https://consumer.example/file.png', {
      resolveHost: async () => ['1.1.1.1'],
      requestImpl,
    });

    expect(requestImpl).toHaveBeenCalledWith(expect.objectContaining({ address: '1.1.1.1' }));
  });
});
