import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createWebhookService } from '../../src/webhooks';
import { createTestApp, createTestDb } from '../helpers';
import setRequest from '../fixtures/evolution/webhook-set.request.json';

const API_KEY = 'test-api-key-0000';

async function appWithInstance(name = 'acme') {
  const db = createTestDb();
  await db.instanceRecord.create({ data: { name } });
  return createTestApp({ webhookService: createWebhookService({ db }) });
}

describe('POST /webhook/set/:instanceName', () => {
  it('stores the configuration and answers 201 with the reference row shape', async () => {
    const app = await appWithInstance();

    const response = await request(app)
      .post('/webhook/set/acme')
      .set('apikey', API_KEY)
      .send(setRequest)
      .expect(201);

    expect(Object.keys(response.body).sort()).toEqual(
      [
        'createdAt',
        'enabled',
        'events',
        'headers',
        'id',
        'instanceId',
        'hasSignatureSecret',
        'signatureEnabled',
        'updatedAt',
        'url',
        'webhookBase64',
        'webhookByEvents',
      ].sort(),
    );
    expect(response.body).toMatchObject({
      url: 'https://consumer.example/webhooks/whatsapp',
      headers: { 'X-Customer': 'acme' },
      hasSignatureSecret: false,
      signatureEnabled: false,
      enabled: true,
      events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
      webhookByEvents: false,
      webhookBase64: false,
    });
  });

  it('accepts an optional signatureSecret, enables signing, and keeps it write-only', async () => {
    const app = await appWithInstance();

    const response = await request(app)
      .post('/webhook/set/acme')
      .set('apikey', API_KEY)
      .send({
        webhook: {
          url: 'https://consumer.example/webhooks/whatsapp',
          events: ['CONNECTION_UPDATE'],
          signatureSecret: 'whsec_1234567890',
        },
      })
      .expect(201);

    expect(response.body).not.toHaveProperty('signatureSecret');
    expect(response.body.hasSignatureSecret).toBe(true);
    expect(response.body.signatureEnabled).toBe(true);

    const found = await request(app).get('/webhook/find/acme').set('apikey', API_KEY).expect(200);
    expect(found.body).not.toHaveProperty('signatureSecret');
    expect(found.body).toMatchObject({ hasSignatureSecret: true, signatureEnabled: true });
  });

  it('enables signing with a stored secret without sending it again', async () => {
    const app = await appWithInstance();
    const path = '/webhook/set/acme';
    const headers = { apikey: API_KEY };
    const url = 'https://consumer.example/webhooks/whatsapp';

    await request(app).post(path).set(headers).send({ webhook: {
      url, signatureSecret: 'whsec_1234567890', signatureEnabled: false,
    } }).expect(201);

    const enabled = await request(app).post(path).set(headers).send({ webhook: {
      url, signatureEnabled: true,
    } }).expect(201);
    expect(enabled.body).toMatchObject({ hasSignatureSecret: true, signatureEnabled: true });
    expect(enabled.body).not.toHaveProperty('signatureSecret');

    await createTestDb().instanceRecord.create({ data: { name: 'fresh' } });
    const missing = await request(app).post('/webhook/set/fresh').set(headers).send({ webhook: {
      url, signatureEnabled: true,
    } }).expect(400);
    expect(missing.body.response.message).toContain('"signatureSecret" is required when "signatureEnabled" is true');
  });

  it('accepts null and an empty string to clear the signing secret', async () => {
    const app = await appWithInstance();
    const path = '/webhook/set/acme';
    const headers = { apikey: API_KEY };
    const url = 'https://consumer.example/webhooks/whatsapp';
    await request(app).post(path).set(headers).send({ webhook: { url, signatureSecret: 'whsec_1234567890' } }).expect(201);
    const clearedWithNull = await request(app).post(path).set(headers).send({ webhook: { url, signatureSecret: null } }).expect(201);
    expect(clearedWithNull.body.hasSignatureSecret).toBe(false);
    await request(app).post(path).set(headers).send({ webhook: { url, signatureSecret: 'whsec_1234567890' } }).expect(201);
    const clearedWithEmpty = await request(app).post(path).set(headers).send({ webhook: { url, signatureSecret: '' } }).expect(201);
    expect(clearedWithEmpty.body.hasSignatureSecret).toBe(false);
    await request(app).post(path).set(headers).send({ webhook: { url, signatureSecret: 'whsec_1234567890' } }).expect(201);
    const clearedWithWhitespace = await request(app).post(path).set(headers).send({ webhook: { url, signatureSecret: '   ' } }).expect(201);
    expect(clearedWithWhitespace.body.hasSignatureSecret).toBe(false);
  });

  it('accepts surrounding whitespace on a URL and signing secret', async () => {
    const app = await appWithInstance();
    const response = await request(app)
      .post('/webhook/set/acme')
      .set('apikey', API_KEY)
      .send({ webhook: {
        url: '  https://consumer.example/webhooks/whatsapp  ',
        signatureSecret: '  whsec_1234567890  ',
      } })
      .expect(201);

    expect(response.body.url).toBe('https://consumer.example/webhooks/whatsapp');
    expect(response.body.hasSignatureSecret).toBe(true);
  });

  it('accepts a non-ASCII URL the domain validator accepts', async () => {
    const app = await appWithInstance();
    await request(app)
      .post('/webhook/set/acme')
      .set('apikey', API_KEY)
      .send({ webhook: { url: 'https://bücher.example/hooks/señal' } })
      .expect(201);
  });

  it('rejects an unknown instance with the reference 404 body', async () => {
    const app = await appWithInstance();

    const response = await request(app)
      .post('/webhook/set/missing')
      .set('apikey', API_KEY)
      .send(setRequest)
      .expect(404);

    expect(response.body).toEqual({
      status: 404,
      error: 'Not Found',
      response: { message: 'Instance "missing" not found' },
    });
  });

  it('reports every validation problem in one 400', async () => {
    const app = await appWithInstance();

    const response = await request(app)
      .post('/webhook/set/acme')
      .set('apikey', API_KEY)
      .send({ webhook: { url: 'nope', events: ['CHATWOOT_IMPORT'] } })
      .expect(400);

    expect(response.body).toEqual({
      status: 400,
      error: 'Bad Request',
      response: { message: ['"url" must be an absolute URL', 'unsupported events: CHATWOOT_IMPORT'] },
    });
  });

  it('rejects an invalid instance name', async () => {
    const app = await appWithInstance();

    // `..` is normalized away by the URL parser, so use a name the validator rejects.
    const response = await request(app)
      .post(`/webhook/set/${'x'.repeat(33)}`)
      .set('apikey', API_KEY)
      .send(setRequest)
      .expect(400);

    expect(response.body.response.message).toBe('Invalid instance name');
  });

  it('needs the api key', async () => {
    const app = await appWithInstance();

    await request(app).post('/webhook/set/acme').send(setRequest).expect(401);
  });
});

describe('GET /webhook/find/:instanceName', () => {
  it('returns the stored configuration', async () => {
    const app = await appWithInstance();
    await request(app).post('/webhook/set/acme').set('apikey', API_KEY).send(setRequest).expect(201);

    const response = await request(app).get('/webhook/find/acme').set('apikey', API_KEY).expect(200);

    expect(response.body.url).toBe('https://consumer.example/webhooks/whatsapp');
  });

  it('answers null for an unknown instance or an unconfigured one', async () => {
    const app = await appWithInstance();

    expect((await request(app).get('/webhook/find/acme').set('apikey', API_KEY).expect(200)).body).toBeNull();
    expect((await request(app).get('/webhook/find/missing').set('apikey', API_KEY).expect(200)).body).toBeNull();
  });
});
