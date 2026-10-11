import { describe, expect, it } from 'vitest';
import { SUPPORTED_EVENTS } from '../../src/contracts/evolution';
import {
  InstanceNotFoundError,
  WebhookValidationError,
  createWebhookService,
  parseWebhookConfig,
  validateCallbackUrl,
} from '../../src/webhooks';
import { createTestDb } from '../helpers';
import setRequest from '../fixtures/evolution/webhook-set.request.json';
import setInvalid from '../fixtures/evolution/webhook-set.invalid.json';

async function serviceWithInstance(name = 'acme') {
  const db = createTestDb();
  const instance = await db.instanceRecord.create({ data: { name } });
  return { db, instance, service: createWebhookService({ db, allowInsecureUrls: false }) };
}

describe('validateCallbackUrl', () => {
  it('accepts anything http(s) in development', () => {
    expect(validateCallbackUrl('http://192.168.1.10/hook', true)).toEqual([]);
    expect(validateCallbackUrl('https://consumer.example/hook', true)).toEqual([]);
  });

  it('rejects non-http protocols even in development', () => {
    expect(validateCallbackUrl('file:///etc/passwd', true)).toEqual(['"url" must use http or https']);
  });

  it('requires https outside development, except on loopback', () => {
    expect(validateCallbackUrl('https://consumer.example/hook', false)).toEqual([]);
    expect(validateCallbackUrl('http://localhost:3000/hook', false)).toEqual([]);
    expect(validateCallbackUrl('http://127.0.0.1:3000/hook', false)).toEqual([]);
    expect(validateCallbackUrl('http://consumer.example/hook', false)).toEqual([
      '"url" must use https outside local development',
    ]);
  });

  it('refuses private and link-local targets outside development', () => {
    for (const url of [
      'https://10.0.0.5/hook',
      'https://172.16.0.1/hook',
      'https://192.168.1.10/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://[fd00::1]/hook',
      'https://printer.local/hook',
    ]) {
      expect(validateCallbackUrl(url, false, false)).toEqual([
        '"url" must not target a private or link-local address',
      ]);
    }
  });

  it('accepts a LAN consumer over plain http when private targets are allowed', () => {
    for (const url of [
      'http://192.168.1.153:4000/webhooks/evolution/abc',
      'http://10.0.0.5/hook',
      'http://172.16.0.1/hook',
      'https://printer.local/hook',
    ]) {
      expect(validateCallbackUrl(url, false, true)).toEqual([]);
    }
  });

  it('still refuses link-local when private targets are allowed', () => {
    expect(validateCallbackUrl('http://169.254.169.254/latest/meta-data', false, true)).toEqual([
      '"url" must use https outside local development',
    ]);
    expect(validateCallbackUrl('https://169.254.169.254/latest/meta-data', false, true)).toEqual([
      '"url" must not target a link-local address',
    ]);
  });

  it('keeps requiring https for a public host when private targets are allowed', () => {
    expect(validateCallbackUrl('http://consumer.example/hook', false, true)).toEqual([
      '"url" must use https outside local development',
    ]);
  });

  it('reports a missing or unparsable url', () => {
    expect(validateCallbackUrl(undefined, true)).toEqual(['"url" is required']);
    expect(validateCallbackUrl('not-a-url', true)).toEqual(['"url" must be an absolute URL']);
  });
});

describe('parseWebhookConfig', () => {
  it('parses the reference request fixture', () => {
    expect(parseWebhookConfig(setRequest, true)).toEqual({
      url: 'https://consumer.example/webhooks/whatsapp',
      headers: { 'X-Customer': 'acme' },
      enabled: true,
      events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
      webhookByEvents: false,
      webhookBase64: false,
    });
  });

  it('collects every problem in the invalid fixture', () => {
    expect(() => parseWebhookConfig(setInvalid, false)).toThrow(WebhookValidationError);

    try {
      parseWebhookConfig(setInvalid, false);
    } catch (err) {
      expect((err as WebhookValidationError).messages).toEqual([
        '"url" must be an absolute URL',
        'unsupported events: CHATWOOT_IMPORT',
      ]);
    }
  });

  it('subscribes to every supported event when the selection is empty', () => {
    const config = parseWebhookConfig({ webhook: { url: 'https://c.example/h', events: [] } }, true);

    expect(config.events).toEqual([...SUPPORTED_EVENTS]);
    expect(config.enabled).toBe(true);
  });

  it('clears the selection when disabled', () => {
    const config = parseWebhookConfig(
      { webhook: { enabled: false, url: 'https://c.example/h', events: ['MESSAGES_UPSERT'] } },
      true,
    );

    expect(config.events).toEqual([]);
  });

  it('distinguishes omitted headers from cleared headers', () => {
    expect(parseWebhookConfig({ webhook: { url: 'https://c.example/h' } }, true).headers).toBeUndefined();
    expect(parseWebhookConfig({ webhook: { url: 'https://c.example/h', headers: null } }, true).headers).toBeNull();
  });

  it('rejects malformed bodies and header shapes', () => {
    expect(() => parseWebhookConfig({}, true)).toThrow('"webhook" must be an object');
    expect(() => parseWebhookConfig({ webhook: { url: 'https://c.example/h', headers: ['a'] } }, true)).toThrow(
      '"headers" must be an object of string values',
    );
    expect(() =>
      parseWebhookConfig({ webhook: { url: 'https://c.example/h', headers: { 'X-A': 5 } } }, true),
    ).toThrow(/"headers.X-A" must be a string/);
    expect(() =>
      parseWebhookConfig({ webhook: { url: 'https://c.example/h', headers: { 'bad header': 'v' } } }, true),
    ).toThrow(/invalid header name/);
  });

  it('parses signatureSecret with keep/clear/set semantics', () => {
    // Omitted keeps the stored value; null and empty clear it.
    const h = (secret?: unknown) =>
      parseWebhookConfig({ webhook: { url: 'https://c.example/h', signatureSecret: secret } }, true).signatureSecret;
    expect(h()).toBeUndefined();
    expect(h(null)).toBeNull();
    expect(h('')).toBeNull();
    expect(h('  whsec_1234567890  ')).toBe('whsec_1234567890');
    expect(() => h('x'.repeat(15))).toThrow('"signatureSecret" must be at least 16 characters');
    expect(h('x'.repeat(16))).toBe('x'.repeat(16));
    expect(() => h(42)).toThrow('"signatureSecret" must be a string');
    expect(() => h('x'.repeat(513))).toThrow('"signatureSecret" must be at most 512 characters');
  });
});

describe('webhook service', () => {
  it('reports whether an instance exists, which the read response cannot', async () => {
    const { service } = await serviceWithInstance();

    expect(await service.instanceExists('acme')).toBe(true);
    expect(await service.instanceExists('missing')).toBe(false);
    // Both read as null, which is why the check is separate.
    expect(await service.getWebhook('acme')).toBeNull();
    expect(await service.getWebhook('missing')).toBeNull();
  });

  it('returns null for an unknown instance or missing configuration', async () => {
    const { service } = await serviceWithInstance();

    expect(await service.getWebhook('missing')).toBeNull();
    expect(await service.getWebhook('acme')).toBeNull();
  });

  it('refuses to configure an unknown instance', async () => {
    const { service } = await serviceWithInstance();

    await expect(service.setWebhook('missing', setRequest)).rejects.toBeInstanceOf(InstanceNotFoundError);
  });

  it('stores and reads back a configuration', async () => {
    const { service, instance } = await serviceWithInstance();

    const saved = await service.setWebhook('acme', setRequest);

    expect(saved).toMatchObject({
      url: 'https://consumer.example/webhooks/whatsapp',
      headers: { 'X-Customer': 'acme' },
      enabled: true,
      events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
      webhookByEvents: false,
      webhookBase64: false,
      instanceId: instance.id,
    });
    expect(new Date(saved.createdAt).toString()).not.toBe('Invalid Date');
    expect(await service.getWebhook('acme')).toEqual(saved);
  });

  it('updates in place, keeping omitted headers and clearing explicit nulls', async () => {
    const { service } = await serviceWithInstance();
    const first = await service.setWebhook('acme', setRequest);

    const kept = await service.setWebhook('acme', {
      webhook: { url: 'https://consumer.example/other', events: ['MESSAGES_UPSERT'] },
    });
    expect(kept.id).toBe(first.id);
    expect(kept.headers).toEqual({ 'X-Customer': 'acme' });

    const cleared = await service.setWebhook('acme', {
      webhook: { url: 'https://consumer.example/other', events: ['MESSAGES_UPSERT'], headers: null },
    });
    expect(cleared.headers).toBeNull();
  });

  it('reports whether a signing secret is stored without returning it', async () => {
    const { service } = await serviceWithInstance();
    const first = await service.setWebhook('acme', {
      webhook: { url: 'https://consumer.example/other', events: [], signatureSecret: 'whsec_1234567890' },
    });
    expect(first).toMatchObject({ hasSignatureSecret: true });
    expect(first).not.toHaveProperty('signatureSecret');

    const kept = await service.setWebhook('acme', { webhook: { url: 'https://consumer.example/other', events: [] } });
    expect(kept).toMatchObject({ hasSignatureSecret: true });

    const cleared = await service.setWebhook('acme', {
      webhook: { url: 'https://consumer.example/other', events: [], signatureSecret: null },
    });
    expect(cleared).toMatchObject({ hasSignatureSecret: false });
  });

  it('requires a secret to enable signing, and can disable signing without clearing it', async () => {
    const { service } = await serviceWithInstance();

    await expect(
      service.setWebhook('acme', {
        webhook: { url: 'https://consumer.example/other', events: [], signatureEnabled: true },
      }),
    ).rejects.toThrow('"signatureSecret" is required when "signatureEnabled" is true');

    const signed = await service.setWebhook('acme', {
      webhook: {
        url: 'https://consumer.example/other',
        events: [],
        signatureSecret: 'whsec_1234567890',
        signatureEnabled: true,
      },
    });
    expect(signed).toMatchObject({ hasSignatureSecret: true, signatureEnabled: true });

    const unsigned = await service.setWebhook('acme', {
      webhook: { url: 'https://consumer.example/other', events: [], signatureEnabled: false },
    });
    expect(unsigned).toMatchObject({ hasSignatureSecret: true, signatureEnabled: false });
  });

  it('applies the production url policy it was built with', async () => {
    const { service } = await serviceWithInstance();

    await expect(
      service.setWebhook('acme', { webhook: { url: 'http://consumer.example/hook', events: [] } }),
    ).rejects.toBeInstanceOf(WebhookValidationError);
  });
});

describe('listDeliveries', () => {
  // A callback url can carry a token in its path, and the payload carries message
  // content and the envelope apikey. Neither may reach a caller.
  const secretUrl = 'https://consumer.example/hooks/9f3a-secret-token';

  async function withDeliveries() {
    const { db, instance, service } = await serviceWithInstance();
    const base = {
      instanceId: instance.id,
      url: secretUrl,
      payload: { data: { message: { conversation: 'private text' } }, apikey: 'super-secret' },
    };

    await db.webhookDelivery.create({
      data: {
        ...base,
        event: 'CONNECTION_UPDATE',
        dedupeKey: 'a',
        status: 'delivered',
        attempts: 1,
        responseStatus: 200,
        createdAt: new Date('2026-08-30T10:00:00Z'),
        deliveredAt: new Date('2026-08-30T10:00:01Z'),
      },
    });
    await db.webhookDelivery.create({
      data: {
        ...base,
        event: 'MESSAGES_UPSERT',
        dedupeKey: 'b',
        status: 'failed',
        attempts: 3,
        responseStatus: 404,
        lastError: 'consumer responded 404',
        createdAt: new Date('2026-08-30T11:00:00Z'),
      },
    });

    return { db, service };
  }

  it('returns the newest attempts first with what a reader needs', async () => {
    const { service } = await withDeliveries();

    const deliveries = await service.listDeliveries('acme');

    expect(deliveries.map((delivery) => delivery.event)).toEqual(['MESSAGES_UPSERT', 'CONNECTION_UPDATE']);
    expect(deliveries[0]).toMatchObject({
      status: 'failed',
      attempts: 3,
      responseStatus: 404,
      lastError: 'consumer responded 404',
    });
    expect(deliveries[1]).toMatchObject({ status: 'delivered', responseStatus: 200 });
  });

  it('never returns the payload or the callback url', async () => {
    const { service } = await withDeliveries();

    const serialized = JSON.stringify(await service.listDeliveries('acme'));

    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('private text');
    expect(Object.keys((await service.listDeliveries('acme'))[0])).not.toContain('payload');
  });

  it('caps how much history it reads', async () => {
    const { service } = await withDeliveries();

    expect(await service.listDeliveries('acme', 1)).toHaveLength(1);
  });

  it('answers with nothing for an unknown instance', async () => {
    const { service } = await withDeliveries();

    expect(await service.listDeliveries('ghost')).toEqual([]);
  });
});
