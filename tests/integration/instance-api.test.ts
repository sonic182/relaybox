import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { InstanceAlreadyExistsError, InstanceNameTakenError } from '../../src/instances';
import connectQr from '../fixtures/evolution/instance-connect-qr.json';
import connectionState from '../fixtures/evolution/instance-connection-state.json';
import { createFakeInstanceService, createTestApp } from '../helpers';
import type { WebhookService } from '../../src/webhooks';

const API_KEY = 'test-api-key-0000';

async function appWith(status: 'connecting' | 'qr' | 'open' | 'close' = 'open') {
  const instanceService = createFakeInstanceService();
  await instanceService.createInstance('acme');
  const instance = instanceService.getInstance('acme');
  if (instance) instance.status = status;

  return createTestApp({ instanceService });
}

async function expectMissingInstance(method: 'get' | 'delete', path: string) {
  const response = await request(await appWith())[method](path).set('apikey', API_KEY).expect(404);
  expect(response.body).toEqual({
    status: 404,
    error: 'Not Found',
    response: { message: 'The "ghost" instance does not exist' },
  });
}

describe('POST /instance/create', () => {
  it('creates an instance with the Evolution response fields', async () => {
    const instanceService = createFakeInstanceService();
    const response = await request(createTestApp({ instanceService }))
      .post('/instance/create')
      .set('apikey', API_KEY)
      .send({ instanceName: 'sales', integration: 'WHATSAPP-BAILEYS' })
      .expect(201);

    expect(response.body).toEqual({
      instance: {
        instanceName: 'sales',
        instanceId: 'id-sales',
        integration: 'WHATSAPP-BAILEYS',
        status: 'connecting',
      },
    });
    expect(instanceService.createInstance).toHaveBeenCalledWith('sales', { failIfExists: true });
  });

  it('returns the QR code at the reference response level', async () => {
    const instanceService = createFakeInstanceService();
    const created = {
      id: 'id-sales',
      name: 'sales',
      status: 'qr' as const,
      qr: 'qr-code',
      qrDataUrl: 'data:image/png;base64,qr',
    };
    let visible = false;
    instanceService.getInstance = (name) => (visible && name === 'sales' ? created : undefined);
    instanceService.createInstance = vi.fn(async () => {
      visible = true;
      return created;
    });

    const response = await request(createTestApp({ instanceService }))
      .post('/instance/create')
      .set('apikey', API_KEY)
      .send({ instanceName: 'sales', qrcode: true })
      .expect(201);

    expect(response.body).toEqual({
      instance: {
        instanceName: 'sales',
        instanceId: 'id-sales',
        integration: 'WHATSAPP-BAILEYS',
        status: 'connecting',
      },
      qrcode: { base64: 'data:image/png;base64,qr', code: 'qr-code' },
    });
  }, 5000);

  it('rejects duplicate and unsupported creates', async () => {
    const instanceService = createFakeInstanceService();
    await instanceService.createInstance('sales');
    const app = createTestApp({ instanceService });

    await request(app).post('/instance/create').set('apikey', API_KEY).send({ instanceName: 'sales' }).expect(409);
    await request(app).post('/instance/create').set('apikey', API_KEY).send({ instanceName: 'new', token: 'secret' }).expect(400);
  });

  it('applies a webhook configuration supplied with the create request', async () => {
    const instanceService = createFakeInstanceService();
    const validateWebhook = vi.fn();
    const setWebhook = vi.fn(async () => ({}));
    const webhookService = { validateWebhook, setWebhook } as unknown as WebhookService;
    const webhook = { url: 'https://hooks.example.test/events', events: ['MESSAGES_UPSERT'] };

    await request(createTestApp({ instanceService, webhookService }))
      .post('/instance/create')
      .set('apikey', API_KEY)
      .send({ instanceName: 'sales', integration: 'WHATSAPP-BAILEYS', webhook })
      .expect(201);

    expect(validateWebhook).toHaveBeenCalledWith({ webhook });
    expect(setWebhook).toHaveBeenCalledWith('sales', { webhook });
  });

  it('rejects invalid webhook configuration before creating the instance', async () => {
    const instanceService = createFakeInstanceService();

    await request(createTestApp({ instanceService }))
      .post('/instance/create')
      .set('apikey', API_KEY)
      .send({ instanceName: 'sales', webhook: { url: 'not-a-url' } })
      .expect(400);

    expect(instanceService.createInstance).not.toHaveBeenCalled();
  });

  it('removes the instance when webhook persistence fails', async () => {
    const instanceService = createFakeInstanceService();
    const webhookService = {
      validateWebhook: vi.fn(),
      setWebhook: vi.fn(async () => {
        throw new Error('database unavailable');
      }),
    } as unknown as WebhookService;

    await request(createTestApp({ instanceService, webhookService }))
      .post('/instance/create')
      .set('apikey', API_KEY)
      .send({ instanceName: 'sales', webhook: { url: 'https://hooks.example.test/events' } })
      .expect(500);

    expect(instanceService.deleteInstance).toHaveBeenCalledWith('sales');
    expect(instanceService.getInstance('sales')).toBeUndefined();
  });

  it('returns conflict when a concurrent create is rejected by the service', async () => {
    const instanceService = createFakeInstanceService();
    instanceService.createInstance = vi.fn(async () => {
      throw new InstanceAlreadyExistsError('sales');
    });

    const response = await request(createTestApp({ instanceService }))
      .post('/instance/create')
      .set('apikey', API_KEY)
      .send({ instanceName: 'sales' })
      .expect(409);

    expect(response.body).toMatchObject({
      status: 409,
      error: 'Conflict',
      response: { message: 'The "sales" instance already exists' },
    });
  });
});

describe('GET /instance/fetchInstances', () => {
  it('lists instances and supports reference filters', async () => {
    const instanceService = createFakeInstanceService();
    await instanceService.createInstance('acme');
    const instance = instanceService.getInstance('acme');
    if (instance) instance.status = 'open';

    const response = await request(createTestApp({ instanceService }))
      .get('/instance/fetchInstances?instanceName=acme')
      .set('apikey', API_KEY)
      .expect(200);

    expect(response.body).toEqual([{ id: 'id-acme', name: 'acme', connectionStatus: 'open' }]);

    await request(createTestApp({ instanceService }))
      .get('/instance/fetchInstances')
      .set('apikey', API_KEY)
      .expect(200)
      .expect([{ id: 'id-acme', name: 'acme', connectionStatus: 'open' }]);

    await request(createTestApp({ instanceService }))
      .get('/instance/fetchInstances?instanceId=id-acme')
      .set('apikey', API_KEY)
      .expect(200)
      .expect([{ id: 'id-acme', name: 'acme', connectionStatus: 'open' }]);
  });

  it('returns the reference error for a missing filtered instance', async () => {
    await expectMissingInstance('get', '/instance/fetchInstances?instanceName=ghost');
  });
});

describe('DELETE /instance/delete/:instanceName', () => {
  it('deletes the instance with the reference success body', async () => {
    const instanceService = createFakeInstanceService();
    await instanceService.createInstance('acme');

    const response = await request(createTestApp({ instanceService }))
      .delete('/instance/delete/acme')
      .set('apikey', API_KEY)
      .expect(200);

    expect(response.body).toEqual({ status: 'SUCCESS', error: false, response: { message: 'Instance deleted' } });
    expect(instanceService.deleteInstance).toHaveBeenCalledWith('acme');
  });
});

describe('instance lifecycle extensions', () => {
  it('renames an instance', async () => {
    const instanceService = createFakeInstanceService();
    await instanceService.createInstance('acme');

    await request(createTestApp({ instanceService }))
      .post('/instance/rename/acme')
      .set('apikey', API_KEY)
      .send({ newName: 'sales' })
      .expect(200);

    expect(instanceService.renameInstance).toHaveBeenCalledWith('acme', 'sales');
  });

  it('maps a service rename collision to conflict', async () => {
    const instanceService = createFakeInstanceService();
    await instanceService.createInstance('acme');
    instanceService.renameInstance = vi.fn(async () => {
      throw new InstanceNameTakenError('sales');
    });

    await request(createTestApp({ instanceService }))
      .post('/instance/rename/acme')
      .set('apikey', API_KEY)
      .send({ newName: 'sales' })
      .expect(409)
      .expect({
        status: 409,
        error: 'Conflict',
        response: { message: 'The "sales" instance name is already in use' },
      });
  });

  it('disconnects an instance', async () => {
    const instanceService = createFakeInstanceService();
    await instanceService.createInstance('acme');

    await request(createTestApp({ instanceService }))
      .post('/instance/disconnect/acme')
      .set('apikey', API_KEY)
      .expect(200);

    expect(instanceService.disconnectInstance).toHaveBeenCalledWith('acme');
  });
});

describe('GET /instance/connectionState/:instanceName', () => {
  it('reproduces the reference response for a connected instance', async () => {
    const response = await request(await appWith('open')).get('/instance/connectionState/acme')
      .set('apikey', API_KEY)
      .expect(200);

    expect(response.body).toEqual(connectionState);
  });

  it.each([
    ['close', 'close'],
    ['connecting', 'connecting'],
    // The QR step is ours alone; the reference only knows the Baileys states.
    ['qr', 'connecting'],
  ] as const)('reports %s as %s', async (status, state) => {
    const response = await request(await appWith(status)).get('/instance/connectionState/acme')
      .set('apikey', API_KEY)
      .expect(200);

    expect(response.body.instance).toEqual({ instanceName: 'acme', state });
  });

  it('answers 404 with the reference wording for an unknown instance', async () => {
    await expectMissingInstance('get', '/instance/connectionState/ghost');
  });

  // `..` never reaches the route: the client normalizes it out of the path first.
  it('rejects a name the service would refuse', async () => {
    const response = await request(await appWith())
      .get(`/instance/connectionState/${'x'.repeat(33)}`)
      .set('apikey', API_KEY)
      .expect(400);

    expect(response.body.response.message).toBe('Invalid instance name');
  });

  it('requires the api key', async () => {
    await request(await appWith()).get('/instance/connectionState/acme').expect(401);
  });

});

describe('GET /instance/connect/:instanceName', () => {
  it('reports open the same way connectionState does', async () => {
    const response = await request(await appWith('open')).get('/instance/connect/acme')
      .set('apikey', API_KEY)
      .expect(200);

    expect(response.body).toEqual(connectionState);
  });

  it('returns the cached qr as a png data url', async () => {
    const instanceService = createFakeInstanceService();
    await instanceService.createInstance('acme');
    const instance = instanceService.getInstance('acme');
    if (instance) {
      instance.status = 'qr';
      instance.qrDataUrl = connectQr.base64;
    }

    const response = await request(createTestApp({ instanceService })).get('/instance/connect/acme')
      .set('apikey', API_KEY)
      .expect(200);

    expect(response.body).toEqual(connectQr);
  });

  it('reconnects a closed instance and waits for its qr before responding', async () => {
    const instanceService = createFakeInstanceService();
    await instanceService.createInstance('acme');
    const instance = instanceService.getInstance('acme');
    if (instance) instance.status = 'close';
    // The fake `reconnectInstance` opens immediately; the route still pays the fixed wait.
    const response = await request(createTestApp({ instanceService })).get('/instance/connect/acme')
      .set('apikey', API_KEY)
      .expect(200);

    expect(instanceService.reconnectInstance).toHaveBeenCalledWith('acme');
    expect(response.body).toEqual(connectionState);
  }, 8000);

  it('answers 404 with the reference wording for an unknown instance', async () => {
    await expectMissingInstance('get', '/instance/connect/ghost');
  });

  it('rejects a name the service would refuse', async () => {
    await request(await appWith())
      .get(`/instance/connect/${'x'.repeat(33)}`)
      .set('apikey', API_KEY)
      .expect(400);
  });

  it('requires the api key', async () => {
    await request(await appWith()).get('/instance/connect/acme').expect(401);
  });
});

describe('DELETE /instance/logout/:instanceName', () => {
  it('unpairs a connected instance', async () => {
    const instanceService = createFakeInstanceService();
    await instanceService.createInstance('acme');

    await request(createTestApp({ instanceService })).delete('/instance/logout/acme')
      .set('apikey', API_KEY)
      .expect(200);

    expect(instanceService.logoutInstance).toHaveBeenCalledWith('acme');
  });

  it('answers 404 with the reference wording for an unknown instance', async () => {
    await expectMissingInstance('delete', '/instance/logout/ghost');
  });

  it('rejects a name the service would refuse', async () => {
    await request(await appWith())
      .delete(`/instance/logout/${'x'.repeat(33)}`)
      .set('apikey', API_KEY)
      .expect(400);
  });

  it('requires the api key', async () => {
    await request(await appWith()).delete('/instance/logout/acme').expect(401);
  });
});
