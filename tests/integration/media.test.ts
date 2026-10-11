import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import pino, { type Logger } from 'pino';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCP_MEDIA_URL_TTL } from '../../src/config';
import { buildMediaUrl } from '../../src/mediaAccess';
import { createFakeChatService, createTestApp } from '../helpers';

const directory = join(process.env.MEDIA_DIR!, 'signed-media');
const bytes = Buffer.from('signed-media-bytes');

function signedPath(name = 'signed-media', keyId = 'm1', now = Date.now()) {
  const url = new URL(buildMediaUrl(name, keyId, now).url);
  return url.pathname + url.search;
}

function mediaApp(path = 'pic.png', mimetype = 'image/png', logger?: Logger) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'pic.png'), bytes);
  const chats = createFakeChatService({
    getMedia: vi.fn(async (name, id) => name === 'signed-media' && id === 'm1'
      ? { path, mimetype, messageType: 'imageMessage' }
      : null),
  });
  return { app: createTestApp({ chatService: chats, logger }), chats };
}

afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('signed media HTTP route', () => {
  it('serves exact bytes without a cookie or API key and prevents script execution', async () => {
    const { app } = mediaApp();
    const response = await request(app).get(signedPath()).expect(200);
    expect(response.body).toEqual(bytes);
    expect(response.headers['content-type']).toContain('image/png');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain('sandbox');
  });

  it('never logs signed query credentials, including rejected requests', async () => {
    let output = '';
    const logger = pino(new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    }));
    const { app } = mediaApp('pic.png', 'image/png', logger);
    const valid = signedPath();
    await request(app).get(valid).expect(200);
    await request(app).get(valid.replace('sig=', 'sig=bad')).expect(403);
    const records = output.trim().split('\n').map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.req.url).toBe('/media/signed-media/m1');
    }
    expect(output).not.toContain(new URL(valid, 'http://localhost').searchParams.get('sig'));
    expect(output).not.toContain('exp=');
    expect(output).not.toContain('sig=');
  });

  it('rejects missing, tampered, expired and cross-instance tokens before looking up media', async () => {
    const { app, chats } = mediaApp();
    const valid = signedPath();
    for (const path of [
      '/media/signed-media/m1',
      valid.replace('sig=', 'sig=bad'),
      signedPath('signed-media', 'm1', Date.now() - (MCP_MEDIA_URL_TTL + 60) * 1000),
      valid.replace('/signed-media/', '/other/'),
    ]) {
      await request(app).get(path).expect(403);
    }
    expect(chats.getMedia).not.toHaveBeenCalled();
  });

  it('returns 404 for missing messages, other instances and missing files', async () => {
    const { app } = mediaApp('missing.png');
    for (const path of [signedPath(), signedPath('signed-media', 'unknown'), signedPath('other')]) {
      await request(app).get(path).expect(404);
    }
  });

  it('does not serve a stored path outside the instance directory', async () => {
    const outside = join(process.env.MEDIA_DIR!, 'outside.png');
    writeFileSync(outside, bytes);
    try {
      const { app } = mediaApp('../outside.png');
      await request(app).get(signedPath()).expect(404);
    } finally {
      rmSync(outside, { force: true });
    }
  });
});
