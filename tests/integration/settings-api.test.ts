import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createControlService, createControlValidator } from '../../src/api/control';
import { createSettingsService } from '../../src/settings';
import { createWebhookService } from '../../src/webhooks';
import { createFakeInstanceService, createTestApp, createTestDb, silentLogger } from '../helpers';

const API_KEY = 'test-api-key-0000';

async function appWithInstance(name = 'acme') {
  await createTestDb().instanceRecord.create({ data: { name } });
  return createTestApp();
}

describe('settings API', () => {
  it('defaults to off, stores the setting, and reads it back', async () => {
    const app = await appWithInstance();

    const initial = await request(app).get('/settings/find/acme').set('apikey', API_KEY).expect(200);
    expect(initial.body).toEqual({ syncFullHistory: false, alwaysOnline: false });

    const set = await request(app)
      .post('/settings/set/acme')
      .set('apikey', API_KEY)
      .send({ syncFullHistory: true })
      .expect(201);
    expect(set.body).toEqual({ settings: { instanceName: 'acme', settings: { syncFullHistory: true, alwaysOnline: false } } });

    const found = await request(app).get('/settings/find/acme').set('apikey', API_KEY).expect(200);
    expect(found.body).toEqual({ syncFullHistory: true, alwaysOnline: false });

    // What find returns can be written back unchanged.
    const roundTrip = await request(app).post('/settings/set/acme').set('apikey', API_KEY).send(found.body).expect(201);
    expect(roundTrip.body.settings.settings).toEqual(found.body);
  });

  it('updates alwaysOnline alone, keeps the other setting, and applies it to the instance', async () => {
    await createTestDb().instanceRecord.create({ data: { name: 'acme' } });
    const instanceService = createFakeInstanceService();
    const app = createTestApp({ instanceService });

    await request(app).post('/settings/set/acme').set('apikey', API_KEY).send({ syncFullHistory: true }).expect(201);
    expect(instanceService.setOnlinePresence).not.toHaveBeenCalled();

    const set = await request(app).post('/settings/set/acme').set('apikey', API_KEY).send({ alwaysOnline: true }).expect(201);
    expect(set.body.settings.settings).toEqual({ syncFullHistory: true, alwaysOnline: true });
    expect(instanceService.setOnlinePresence).toHaveBeenCalledWith('acme', true);
  });

  it('rejects unsupported fields and non-boolean values', async () => {
    const app = await appWithInstance();

    await request(app).post('/settings/set/acme').set('apikey', API_KEY).send({ syncFullHistory: true, rejectCall: true }).expect(400);
    await request(app).post('/settings/set/acme').set('apikey', API_KEY).send({ syncFullHistory: 'yes' }).expect(400);
    await request(app).post('/settings/set/acme').set('apikey', API_KEY).send({ alwaysOnline: null }).expect(400);
    await request(app).post('/settings/set/acme').set('apikey', API_KEY).send({}).expect(400);
  });

  it('answers 404 for an unknown instance and needs the api key', async () => {
    const app = await appWithInstance();

    await request(app).get('/settings/find/ghost').set('apikey', API_KEY).expect(404);
    await request(app).post('/settings/set/ghost').set('apikey', API_KEY).send({ syncFullHistory: true }).expect(404);
    await request(app).get('/settings/find/acme').expect(401);
  });

  it('stores the settings given when the instance is created', async () => {
    const instanceService = createFakeInstanceService();
    const db = createTestDb();
    const created = instanceService.createInstance.bind(instanceService);
    instanceService.createInstance = async (name, options) => {
      const instance = await created(name, options);
      await db.instanceRecord.create({ data: { id: instance.id, name } });
      return instance;
    };
    const app = createTestApp({
      instanceService,
      controlService: createControlService({
        validator: await createControlValidator(),
        instanceService,
        webhookService: createWebhookService({ db }),
        settingsService: createSettingsService({ db }),
        logger: silentLogger(),
      }),
    });

    await request(app)
      .post('/instance/create')
      .set('apikey', API_KEY)
      .send({ instanceName: 'sales', syncFullHistory: true, alwaysOnline: true })
      .expect(201);

    const found = await request(app).get('/settings/find/sales').set('apikey', API_KEY).expect(200);
    expect(found.body).toEqual({ syncFullHistory: true, alwaysOnline: true });
    await request(app).post('/instance/create').set('apikey', API_KEY).send({ instanceName: 'other', alwaysOnline: 'yes' }).expect(400);
  });
});
