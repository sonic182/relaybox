import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { DbNull } from '@zenstackhq/orm';
import { createDeliveryHandler, isRetryableStatus } from '../../src/delivery';
import { createTestDb, silentLogger } from '../helpers';

async function seedInstance(
  headers: Record<string, string> | null = null,
  signatureSecret: string | null = null,
  signatureEnabled = Boolean(signatureSecret),
  name = 'acme',
) {
  const db = createTestDb();
  const instance = await db.instanceRecord.create({ data: { name } });
  if (headers || signatureSecret) {
    await db.webhookConfig.create({
      data: {
        instanceId: instance.id,
        url: 'https://consumer.example/hook',
        events: [],
        headers: headers ?? DbNull,
        ...(signatureSecret ? { signatureSecret } : {}),
        signatureEnabled,
      },
    });
  }
  return { db, instance };
}

function job(instanceId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'delivery-1',
    instanceId,
    event: 'CONNECTION_UPDATE',
    url: 'https://consumer.example/hook',
    payload: { event: 'connection.update' },
    attempts: 0,
    ...overrides,
  };
}

function fakeRequest(status: number) {
  return vi.fn().mockResolvedValue({ status });
}

describe('isRetryableStatus', () => {
  it('retries timeouts, rate limits, and server errors; not other 4xx', () => {
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });
});

describe('createDeliveryHandler', () => {
  it('reports delivered on a 2xx response and sends the configured and observability headers', async () => {
    const { db, instance } = await seedInstance({ Authorization: 'Bearer secret' });
    const requestImpl = fakeRequest(200);
    const deliver = createDeliveryHandler({ db, logger: silentLogger(), requestImpl, allowInsecureUrls: true });

    const outcome = await deliver(job(instance.id));

    expect(outcome).toEqual({ status: 'delivered', responseStatus: 200 });
    const [request] = requestImpl.mock.calls[0];
    expect(request.headers).toMatchObject({
      Authorization: 'Bearer secret',
      'x-delivery-id': 'delivery-1',
      'x-event-type': 'CONNECTION_UPDATE',
    });
  });

  it('marks a 4xx as failed and non-retryable', async () => {
    const { db, instance } = await seedInstance();
    const deliver = createDeliveryHandler({ db, logger: silentLogger(), requestImpl: fakeRequest(404), allowInsecureUrls: true });

    expect(await deliver(job(instance.id))).toEqual({
      status: 'failed',
      responseStatus: 404,
      error: 'consumer responded 404',
      retryable: false,
    });
  });

  it('signs the raw body only when signing is enabled, and omits the header otherwise', async () => {
    const { db, instance } = await seedInstance(null, 'whsec_abc123');
    const signedRequest = fakeRequest(200);
    const signed = createDeliveryHandler({
      db,
      logger: silentLogger(),
      requestImpl: signedRequest,
      allowInsecureUrls: true,
    });
    await signed(job(instance.id));
    const body = JSON.stringify({ event: 'connection.update' });
    expect(signedRequest.mock.calls[0][0].headers['x-webhook-signature']).toBe(
      'sha256=' + createHmac('sha256', 'whsec_abc123').update(body).digest('hex'),
    );

    const unsignedInstance = await db.instanceRecord.create({ data: { name: 'acme2' } });
    const unsignedRequest = fakeRequest(200);
    const unsigned = createDeliveryHandler({ db, logger: silentLogger(), requestImpl: unsignedRequest, allowInsecureUrls: true });
    await unsigned(job(unsignedInstance.id));
    expect(unsignedRequest.mock.calls[0][0].headers['x-webhook-signature']).toBeUndefined();

    const { db: disabledDb, instance: disabledInstance } = await seedInstance(
      null,
      'whsec_disabled',
      false,
      'acme-disabled',
    );
    const disabledRequest = fakeRequest(200);
    const disabled = createDeliveryHandler({
      db: disabledDb,
      logger: silentLogger(),
      requestImpl: disabledRequest,
      allowInsecureUrls: true,
    });
    await disabled(job(disabledInstance.id));
    expect(disabledRequest.mock.calls[0][0].headers['x-webhook-signature']).toBeUndefined();
  });

  it('marks a 500 and a 429 as failed and retryable', async () => {
    const { db, instance } = await seedInstance();
    for (const status of [500, 429]) {
      const deliver = createDeliveryHandler({ db, logger: silentLogger(), requestImpl: fakeRequest(status), allowInsecureUrls: true });

      expect(await deliver(job(instance.id))).toMatchObject({ status: 'failed', responseStatus: status, retryable: true });
    }
  });

  it('refuses a redirect response without following it', async () => {
    const { db, instance } = await seedInstance();
    const deliver = createDeliveryHandler({ db, logger: silentLogger(), requestImpl: fakeRequest(302), allowInsecureUrls: true });

    expect(await deliver(job(instance.id))).toEqual({
      status: 'failed',
      responseStatus: 302,
      error: 'refusing to follow a redirect (302)',
      retryable: false,
    });
  });

  it('reports a network failure as retryable', async () => {
    const { db, instance } = await seedInstance();
    const requestImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const deliver = createDeliveryHandler({ db, logger: silentLogger(), requestImpl, allowInsecureUrls: true });

    expect(await deliver(job(instance.id))).toEqual({ status: 'failed', error: 'ECONNREFUSED', retryable: true });
  });

  it('refuses a target that resolves to a private address, without connecting', async () => {
    const { db, instance } = await seedInstance();
    const requestImpl = vi.fn();
    const resolveHost = vi.fn().mockResolvedValue(['10.0.0.5']);
    const deliver = createDeliveryHandler({
      db,
      logger: silentLogger(),
      requestImpl,
      resolveHost,
      allowInsecureUrls: false,
      // Pinned, not inherited: a developer's .env may opt into private targets.
      allowPrivateTargets: false,
    });

    const outcome = await deliver(job(instance.id));

    expect(outcome.status).toBe('failed');
    expect((outcome as { retryable: boolean }).retryable).toBe(false);
    expect((outcome as { error: string }).error).toContain('private address');
    expect(requestImpl).not.toHaveBeenCalled();
  });

  it('delivers to a private address once the operator opts in', async () => {
    const { db, instance } = await seedInstance();
    const requestImpl = fakeRequest(200);
    const deliver = createDeliveryHandler({
      db,
      logger: silentLogger(),
      requestImpl,
      resolveHost: vi.fn(),
      allowInsecureUrls: false,
      allowPrivateTargets: true,
    });

    expect(await deliver(job(instance.id, { url: 'http://192.168.1.153:4000/hook' }))).toEqual({
      status: 'delivered',
      responseStatus: 200,
    });
    expect(requestImpl.mock.calls[0][0].address).toBe('192.168.1.153');
  });

  it('still refuses link-local when private targets are allowed', async () => {
    const { db, instance } = await seedInstance();
    const requestImpl = vi.fn();
    const deliver = createDeliveryHandler({
      db,
      logger: silentLogger(),
      requestImpl,
      resolveHost: vi.fn(),
      allowInsecureUrls: false,
      allowPrivateTargets: true,
    });

    const outcome = await deliver(job(instance.id, { url: 'http://169.254.169.254/latest/meta-data' }));

    expect(outcome.status).toBe('failed');
    expect((outcome as { error: string }).error).toContain('private address');
    expect(requestImpl).not.toHaveBeenCalled();
  });

  it('pins a public DNS result instead of resolving the hostname again', async () => {
    const { db, instance } = await seedInstance();
    const requestImpl = fakeRequest(200);
    const resolveHost = vi.fn().mockResolvedValueOnce(['8.8.8.8']).mockResolvedValueOnce(['10.0.0.5']);
    const deliver = createDeliveryHandler({
      db,
      logger: silentLogger(),
      requestImpl,
      resolveHost,
      allowInsecureUrls: false,
    });

    expect(await deliver(job(instance.id))).toEqual({ status: 'delivered', responseStatus: 200 });
    expect(resolveHost).toHaveBeenCalledTimes(1);
    expect(requestImpl.mock.calls[0][0].address).toBe('8.8.8.8');
  });

  it('refuses a loopback callback unless private targets are allowed', async () => {
    const { db, instance } = await seedInstance();
    const requestImpl = fakeRequest(200);
    const resolveHost = vi.fn().mockResolvedValue(['127.0.0.1']);
    const options = { db, logger: silentLogger(), requestImpl, resolveHost, allowInsecureUrls: false };
    const loopback = job(instance.id, { url: 'http://localhost:3000/hook' });

    const refused = await createDeliveryHandler({ ...options, allowPrivateTargets: false })(loopback);
    expect(refused).toMatchObject({ status: 'failed', retryable: false });
    expect(requestImpl).not.toHaveBeenCalled();

    expect(await createDeliveryHandler({ ...options, allowPrivateTargets: true })(loopback)).toEqual({
      status: 'delivered',
      responseStatus: 200,
    });
    expect(requestImpl.mock.calls[0][0].address).toBe('127.0.0.1');
  });

  it('allows a private target when development mode allows insecure urls', async () => {
    const { db, instance } = await seedInstance();
    const requestImpl = fakeRequest(200);
    const resolveHost = vi.fn().mockResolvedValue(['10.0.0.5']);
    const deliver = createDeliveryHandler({
      db,
      logger: silentLogger(),
      requestImpl,
      resolveHost,
      allowInsecureUrls: true,
    });

    expect(await deliver(job(instance.id))).toEqual({ status: 'delivered', responseStatus: 200 });
    expect(resolveHost).not.toHaveBeenCalled();
  });
});
