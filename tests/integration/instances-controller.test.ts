import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createAuthenticatedAgent, createFakeInstanceService, createTestApp, createTestDb } from '../helpers';

describe('instances controller', () => {
  it('uses its injected service for lifecycle actions', async () => {
    const instanceService = createFakeInstanceService();
    const agent = await createAuthenticatedAgent({ instanceService });

    await agent.post('/instances').type('form').send({ name: 'sales' }).expect(200).expect(/sales/);
    expect(instanceService.createInstance).toHaveBeenCalledWith('sales');

    await agent.post('/instances/sales/disconnect').expect(200).expect(/Disconnected/);
    await agent.post('/instances/sales/connect').expect(200).expect(/Connected/);
    await agent.post('/instances/sales/delete').expect(200).expect(/No instances yet/);

    expect(instanceService.disconnectInstance).toHaveBeenCalledWith('sales');
    expect(instanceService.reconnectInstance).toHaveBeenCalledWith('sales');
    expect(instanceService.deleteInstance).toHaveBeenCalledWith('sales');
  });

  it('creates with history enabled from the modal and keeps duplicate errors in the form', async () => {
    const db = createTestDb();
    const instanceService = createFakeInstanceService();
    const create = instanceService.createInstance.bind(instanceService);
    instanceService.createInstance = async (name, options) => {
      const instance = await create(name, options);
      await db.instanceRecord.create({ data: { id: instance.id, name } });
      return instance;
    };
    const agent = await createAuthenticatedAgent({ instanceService });
    await agent.get('/dashboard').expect(200).expect(/<dialog/).expect(/Import history when pairing/);
    await agent.post('/instances').type('form').send({ name: 'history', syncFullHistory: 'on' })
      .expect(200).expect('HX-Retarget', '#instances').expect(/Edit instance settings/);
    expect(await db.instanceSettings.findFirst()).toMatchObject({ syncFullHistory: true });
    const duplicate = await agent.post('/instances').type('form').send({ name: 'history', syncFullHistory: 'on' }).expect(400);
    expect(duplicate.text).toContain('id="create-instance-form"');
    expect(duplicate.headers['hx-retarget']).toBeUndefined();
    expect(await db.instanceRecord.count()).toBe(1);
  });

  it('unpairs rather than merely disconnecting for a new QR scan', async () => {
    const instanceService = createFakeInstanceService();
    await instanceService.createInstance('sales');
    const agent = await createAuthenticatedAgent({ instanceService });
    await agent.post('/instances/sales/unpair').expect(200).expect(/Re-scan QR/);
    expect(instanceService.logoutInstance).toHaveBeenCalledWith('sales');
    expect(instanceService.disconnectInstance).not.toHaveBeenCalled();
    await request(createTestApp()).post('/instances/sales/unpair').expect(302);
  });

  describe('renaming', () => {
    async function loggedIn() {
      const instanceService = createFakeInstanceService();
      const agent = await createAuthenticatedAgent({ instanceService });
      await agent.post('/instances').type('form').send({ name: 'sales' }).expect(200);
      return { instanceService, agent };
    }

    it('takes the new name from the HX-Prompt header', async () => {
      const { instanceService, agent } = await loggedIn();

      await agent.post('/instances/sales/rename').set('HX-Prompt', ' support ').expect(200).expect(/support/);

      expect(instanceService.renameInstance).toHaveBeenCalledWith('sales', 'support');
    });

    it('rejects an invalid or missing new name', async () => {
      const { instanceService, agent } = await loggedIn();

      await agent.post('/instances/sales/rename').set('HX-Prompt', 'has spaces').expect(400);
      await agent.post('/instances/sales/rename').expect(400);

      expect(instanceService.renameInstance).not.toHaveBeenCalled();
    });

    it('refuses a name another instance already holds', async () => {
      const { instanceService, agent } = await loggedIn();
      await agent.post('/instances').type('form').send({ name: 'support' }).expect(200);

      await agent.post('/instances/sales/rename').set('HX-Prompt', 'support').expect(409);

      expect(instanceService.renameInstance).not.toHaveBeenCalled();
    });

    it('requires authentication', async () => {
      const app = createTestApp();
      await request(app).post('/instances/sales/rename').set('HX-Prompt', 'support').expect(302);
    });
  });
});
