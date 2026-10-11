import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createAuthenticatedAgent, createTestApp, createTestDb } from '../helpers';

describe('instance settings UI', () => {
  it('shows the stored option and persists enabling and disabling it', async () => {
    const db = createTestDb();
    await db.instanceRecord.create({ data: { name: 'sales' } });
    const agent = await createAuthenticatedAgent();
    const initial = await agent.get('/instances/sales/settings').expect(200);
    expect(initial.text).toContain('Edit instance settings — sales');
    expect(initial.text).not.toMatch(/name="syncFullHistory"[^>]*checked/);
    await agent.post('/instances/sales/settings').type('form').send({ syncFullHistory: 'on' })
      .expect(200).expect(/Instance settings saved/);
    const enabled = await agent.get('/instances/sales/settings').expect(200);
    expect(enabled.text).toMatch(/name="syncFullHistory"[^>]*checked/);
    expect(await db.instanceSettings.findFirst()).toMatchObject({ syncFullHistory: true });
    await agent.post('/instances/sales/settings').type('form').send({}).expect(200);
    expect(await db.instanceSettings.findFirst()).toMatchObject({ syncFullHistory: false });
  });

  it('rejects invalid form input and unknown instances and requires login', async () => {
    const db = createTestDb();
    await db.instanceRecord.create({ data: { name: 'sales' } });
    const agent = await createAuthenticatedAgent();
    await agent.post('/instances/sales/settings').type('form').send({ syncFullHistory: 'yes' }).expect(400);
    expect(await db.instanceSettings.count()).toBe(0);
    await agent.get('/instances/missing/settings').expect(404);
    await agent.post('/instances/missing/settings').type('form').send({}).expect(404);
    await request(createTestApp()).get('/instances/sales/settings').expect(302);
    await request(createTestApp()).post('/instances/sales/settings').type('form').send({ syncFullHistory: 'on' }).expect(302);
  });
});
