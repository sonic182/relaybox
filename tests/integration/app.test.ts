import { readFileSync } from 'node:fs';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers';

const TEST_TOKEN = 'test-api-key-0000';

describe('web app', () => {
  it('redirects anonymous visitors to login', async () => {
    const response = await request(createTestApp()).get('/').expect(302);

    expect(response.headers.location).toBe('/login');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('renders the login form and rejects an invalid token', async () => {
    const app = createTestApp();

    await request(app).get('/login').expect(200).expect(/Enter API key/);
    await request(app)
      .post('/login')
      .type('form')
      .send({ token: 'invalid-token' })
      .expect(200)
      .expect('Invalid token');
  });

  it('throttles repeated login attempts from one client', async () => {
    const app = createTestApp();

    for (let attempt = 0; attempt < 10; attempt++) {
      await request(app).post('/login').type('form').send({ token: 'invalid-token' }).expect(200);
    }
    await request(app).post('/login').type('form').send({ token: TEST_TOKEN }).expect(429).expect(/Too many attempts/);
  });

  it('authenticates a valid login and serves the dashboard', async () => {
    const agent = request.agent(createTestApp());

    const login = await agent
      .post('/login')
      .type('form')
      .send({ token: TEST_TOKEN })
      .expect(200)
      .expect('HX-Redirect', '/dashboard');

    expect(login.headers['set-cookie']).toEqual(
      expect.arrayContaining([expect.stringMatching(/^relaybox_session=\d+\.[0-9a-f]{64}; Max-Age=604800;/)]),
    );
    expect(String(login.headers['set-cookie'])).not.toContain(TEST_TOKEN);
    expect(login.headers['set-cookie']).toEqual(
      expect.arrayContaining([expect.stringContaining('HttpOnly')]),
    );

    await agent.get('/dashboard').expect(200).expect(/No instances yet\./);
    await agent.get('/').expect(302).expect('Location', '/dashboard');
  });

  it('rejects cross-site form posts but accepts same-origin ones', async () => {
    const agent = request.agent(createTestApp());
    await agent.post('/login').type('form').send({ token: TEST_TOKEN }).expect(200);

    await agent.post('/logout').set('Sec-Fetch-Site', 'cross-site').expect(403);
    await agent.post('/logout').set('Sec-Fetch-Site', 'same-site').expect(403);
    await agent.post('/logout').set('Origin', 'https://evil.example').expect(403);
    await agent.post('/logout').set('Origin', 'null').expect(403);
    await agent.get('/dashboard').set('Sec-Fetch-Site', 'cross-site').expect(200);

    await agent.post('/logout').set('Sec-Fetch-Site', 'same-origin').expect(200);
    await agent.post('/logout').set('Host', 'relaybox.test').set('Origin', 'https://relaybox.test').expect(200);
  });

  it('protects the dashboard and clears the session at logout', async () => {
    const agent = request.agent(createTestApp());

    await agent.get('/dashboard').expect(302).expect('Location', '/login');
    await agent.post('/login').type('form').send({ token: TEST_TOKEN }).expect(200);

    const logout = await agent.post('/logout').expect(200).expect('HX-Redirect', '/login');
    expect(logout.headers['set-cookie']).toEqual(
      expect.arrayContaining([expect.stringMatching(/^relaybox_session=;/)]),
    );

    await agent.get('/dashboard').expect(302).expect('Location', '/login');
  });

  it('rejects the raw API key as a dashboard cookie and clears the legacy cookie at login', async () => {
    const app = createTestApp();

    for (const cookie of [`relaybox_session=${TEST_TOKEN}`, `api_key=${TEST_TOKEN}`]) {
      await request(app).get('/dashboard').set('Cookie', cookie).expect(302).expect('Location', '/login');
      await request(app).get('/').set('Cookie', cookie).expect(302).expect('Location', '/login');
    }

    const login = await request(app)
      .post('/login')
      .set('Cookie', `api_key=${TEST_TOKEN}`)
      .type('form')
      .send({ token: TEST_TOKEN })
      .expect(200);
    expect(login.headers['set-cookie']).toEqual(expect.arrayContaining([expect.stringMatching(/^api_key=;/)]));
  });

  it('lists instances and rejects unusable names', async () => {
    const agent = request.agent(createTestApp());
    await agent.post('/login').type('form').send({ token: TEST_TOKEN }).expect(200);

    await agent.get('/instances').expect(200).expect(/No instances yet\./);
    await agent
      .post('/instances')
      .type('form')
      .send({ name: '../escape' })
      .expect(400)
      .expect('Invalid instance name');
    await request(createTestApp()).get('/instances').expect(302).expect('Location', '/login');
  });

  it('serves public API documentation without authentication', async () => {
    const app = createTestApp();

    const yaml = await request(app).get('/swagger.yml').expect(200);
    expect(yaml.headers['content-type']).toMatch(/yaml/);
    expect(yaml.text).toContain('/instance/connectionState/{instanceName}:');
    expect(yaml.text).toContain('/message/sendText/{instanceName}:');
    expect(yaml.text).toContain('/chat/updateMessage/{instanceName}:');
    expect(yaml.text).toContain('/webhook/set/{instanceName}:');
    expect(yaml.text).toContain('/webhook/find/{instanceName}:');
    expect(yaml.text).toContain('/instance/fetchInstances:');
    expect(readFileSync('public/swagger.yml', 'utf8')).toContain('/instance/fetchInstances:');

    const json = await request(app).get('/swagger.json').expect(200).expect('Content-Type', /json/);
    expect(json.body.openapi).toBe('3.1.0');
    expect(json.body.paths['/message/sendText/{instanceName}']).toBeDefined();

    await request(app)
      .get('/redoc')
      .expect(200)
      .expect('Content-Type', /html/)
      .expect(/spec-url="\/swagger\.json"/)
      .expect(/redoc\.standalone\.js/);
  });

  it('serves the component gallery in development only', async () => {
    await request(createTestApp()).get('/ui').expect(200).expect(/Components/);

    try {
      for (const env of ['production', 'staging', undefined]) {
        if (env === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = env;
        await request(createTestApp()).get('/ui').expect(404);
      }
    } finally {
      process.env.NODE_ENV = 'test';
    }
  });

  it('embeds the instance list as markup, not escaped text', async () => {
    const agent = request.agent(createTestApp());
    await agent.post('/login').type('form').send({ token: TEST_TOKEN }).expect(200);

    const dashboard = await agent.get('/dashboard').expect(200);
    expect(dashboard.text).not.toMatch(/&lt;div/);
    expect(dashboard.text).toMatch(/<div class="text-slate-500">No instances yet\.<\/div>/);
  });
});
