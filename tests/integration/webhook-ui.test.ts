import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createWebhookService } from '../../src/webhooks';
import { createTestApp, createTestDb } from '../helpers';

const TEST_TOKEN = 'test-api-key-0000';
const webhookForm = {
  enabled: 'on',
  url: 'https://consumer.example/hook',
  events: 'MESSAGES_UPSERT',
};

async function agentWithInstance(name = 'acme') {
  const db = createTestDb();
  await db.instanceRecord.create({ data: { name } });
  const agent = request.agent(createTestApp({ webhookService: createWebhookService({ db }) }));
  await agent.post('/login').type('form').send({ token: TEST_TOKEN }).expect(200);
  return { agent, db };
}

describe('webhook settings page', () => {
  it('requires the dashboard cookie', async () => {
    const db = createTestDb();
    const app = createTestApp({ webhookService: createWebhookService({ db }) });

    await request(app).get('/instances/acme/webhook').expect(302).expect('Location', '/login');
    await request(app).post('/instances/acme/webhook').expect(302).expect('Location', '/login');
  });

  it('renders the form with every supported event', async () => {
    const { agent } = await agentWithInstance();

    const response = await agent.get('/instances/acme/webhook').expect(200);

    expect(response.text).toContain('Webhook — acme');
    expect(response.text).toContain('MESSAGES_UPSERT');
    expect(response.text).toContain('SEND_MESSAGE');
    expect(response.text).toContain('STATUS_UPDATE');
  });

  it('does not render a form for an unknown instance', async () => {
    const { agent } = await agentWithInstance();

    // getWebhook answers null for unknown and unconfigured alike, so the page must
    // not present a form that only fails on save.
    const response = await agent.get('/instances/missing/webhook').expect(404);
    expect(response.text).toContain('Instance not found');
    expect(response.text).not.toContain('Callback URL');
  });

  it('offers an unconfigured instance a disabled form with no url', async () => {
    const { agent } = await agentWithInstance();

    const response = await agent.get('/instances/acme/webhook').expect(200);
    const enabledInput = /<input[^>]*name="enabled"[^>]*>/.exec(response.text)?.[0] ?? '';

    expect(enabledInput).not.toContain('checked');
    expect(response.text).toContain('value=""');
  });

  it('shows the events a save would subscribe to when the stored config is disabled', async () => {
    const { agent } = await agentWithInstance();
    await agent
      .post('/instances/acme/webhook')
      .type('form')
      .send({ url: 'https://consumer.example/hook', events: 'MESSAGES_UPSERT' })
      .expect(200);

    // Saving disabled clears the stored selection, so the form must not imply
    // that re-enabling keeps an empty one.
    const viaApi = await agent.get('/webhook/find/acme').set('apikey', 'test-api-key-0000').expect(200);
    expect(viaApi.body.enabled).toBe(false);
    expect(viaApi.body.events).toEqual([]);

    const page = await agent.get('/instances/acme/webhook').expect(200);
    const checked = page.text.match(/name="events"[^>]*checked/g) ?? [];
    expect(checked).toHaveLength(8);
  });

  it('saves the form through the same service the json api uses', async () => {
    const { agent } = await agentWithInstance();

    const saved = await agent
      .post('/instances/acme/webhook')
      .type('form')
      .send({
        enabled: 'on',
        url: 'https://consumer.example/webhooks/whatsapp',
        events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
        headers: '{"Authorization":"Bearer super-secret"}',
      })
      .expect(200);

    expect(saved.text).toContain('Webhook settings saved.');

    const viaApi = await agent.get('/webhook/find/acme').set('apikey', 'test-api-key-0000').expect(200);
    expect(viaApi.body).toMatchObject({
      url: 'https://consumer.example/webhooks/whatsapp',
      events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
    });
  });

  it('never renders a configured header value', async () => {
    const { agent } = await agentWithInstance();
    await agent
      .post('/instances/acme/webhook')
      .type('form')
      .send({
        enabled: 'on',
        url: 'https://consumer.example/hook',
        events: 'MESSAGES_UPSERT',
        headers: '{"Authorization":"Bearer super-secret"}',
      })
      .expect(200);

    const page = await agent.get('/instances/acme/webhook').expect(200);

    expect(page.text).not.toContain('super-secret');
    expect(page.text).toContain('Currently set: Authorization');
  });

  it('keeps stored headers when the textarea is left empty', async () => {
    const { agent } = await agentWithInstance();
    await agent
      .post('/instances/acme/webhook')
      .type('form')
      .send({ ...webhookForm, headers: '{"Authorization":"Bearer super-secret"}' })
      .expect(200);
    await agent.post('/instances/acme/webhook').type('form').send({ ...webhookForm, headers: '' }).expect(200);

    const viaApi = await agent.get('/webhook/find/acme').set('apikey', 'test-api-key-0000').expect(200);
    expect(viaApi.body.headers).toEqual({ Authorization: 'Bearer super-secret' });
  });

  it('shows a masked configured-secret indicator and can disable signing without clearing the secret', async () => {
    const { agent } = await agentWithInstance();
    await agent
      .post('/instances/acme/webhook')
      .type('form')
      .send({ ...webhookForm, signatureEnabled: 'on', signatureSecret: 'whsec_super_secret' })
      .expect(200);

    const page = await agent.get('/instances/acme/webhook').expect(200);
    expect(page.text).toContain('Sign webhook deliveries');
    expect(page.text).toContain('A signing secret is already configured (••••••••)');
    expect(page.text).not.toContain('whsec_super_secret');

    await agent.post('/instances/acme/webhook').type('form').send(webhookForm).expect(200);
    const viaApi = await agent.get('/webhook/find/acme').set('apikey', 'test-api-key-0000').expect(200);
    expect(viaApi.body).toMatchObject({ hasSignatureSecret: true, signatureEnabled: false });
    expect(viaApi.body).not.toHaveProperty('signatureSecret');
  });

  it('renders controls that generate and copy a one-time signing secret', async () => {
    const { agent } = await agentWithInstance();

    const page = await agent.get('/instances/acme/webhook').expect(200);

    expect(page.text).toContain('data-generate-signature-secret');
    expect(page.text).toContain('data-copy-generated-signature-secret');
    expect(page.text).toContain('Generated signing secret');
    expect(page.text).toContain('until you refresh, leave, or close this page');
  });

  it('reports a short signing secret when the form is saved', async () => {
    const { agent } = await agentWithInstance();

    const response = await agent
      .post('/instances/acme/webhook')
      .type('form')
      .send({
        enabled: 'on',
        url: 'https://consumer.example/hook',
        events: 'MESSAGES_UPSERT',
        signatureEnabled: 'on',
        signatureSecret: 'too-short',
      })
      .expect(400);

    expect(response.text).toContain('&quot;signatureSecret&quot; must be at least 16 characters');
  });

  it('re-renders the form with validation errors', async () => {
    const { agent } = await agentWithInstance();

    const invalidJson = await agent
      .post('/instances/acme/webhook')
      .type('form')
      .send({ enabled: 'on', url: 'https://consumer.example/hook', headers: 'not json' })
      .expect(400);
    expect(invalidJson.text).toContain('&quot;headers&quot; must be valid JSON');

    const invalidUrl = await agent
      .post('/instances/acme/webhook')
      .type('form')
      .send({ enabled: 'on', url: 'nope' })
      .expect(400);
    expect(invalidUrl.text).toContain('must be an absolute URL');
  });

  it('reports an unknown instance without a stack trace', async () => {
    const { agent } = await agentWithInstance();

    const response = await agent
      .post('/instances/missing/webhook')
      .type('form')
      .send({ enabled: 'on', url: 'https://consumer.example/hook' })
      .expect(404);

    expect(response.text).toContain('not found');
  });
});

describe('delivery history on the webhook page', () => {
  async function withDelivery(overrides: Record<string, unknown> = {}) {
    const { agent, db } = await agentWithInstance();
    const [instance] = await db.instanceRecord.findMany();

    await db.webhookDelivery.create({
      data: {
        instanceId: instance.id,
        event: 'MESSAGES_UPSERT',
        url: 'https://consumer.example/hooks/9f3a-secret-token',
        payload: { data: { message: { conversation: 'private text' } }, apikey: 'super-secret' },
        dedupeKey: 'delivery-1',
        status: 'failed',
        attempts: 3,
        responseStatus: 404,
        lastError: 'consumer responded 404',
        ...overrides,
      },
    });

    return agent;
  }

  it('shows what a reader needs to tell whether a consumer is accepting deliveries', async () => {
    const agent = await withDelivery();

    const response = await agent.get('/instances/acme/webhook').expect(200);

    expect(response.text).toContain('Recent deliveries');
    expect(response.text).toContain('MESSAGES_UPSERT');
    expect(response.text).toContain('404');
    expect(response.text).toContain('consumer responded 404');
  });

  // The url can carry a token in its path and the payload carries message content.
  it('leaks neither the callback url nor the payload', async () => {
    const agent = await withDelivery();

    const response = await agent.get('/instances/acme/webhook').expect(200);

    expect(response.text).not.toContain('secret-token');
    expect(response.text).not.toContain('super-secret');
    expect(response.text).not.toContain('private text');
  });

  it('says so when there is no history yet', async () => {
    const { agent } = await agentWithInstance();

    const response = await agent.get('/instances/acme/webhook').expect(200);

    expect(response.text).toContain('No deliveries yet.');
  });
});
