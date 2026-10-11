import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers';
import unauthorized from '../fixtures/evolution/error.unauthorized.json';

const API_KEY = 'test-api-key-0000';

const app = createTestApp;

describe('json api', () => {
  it('rejects a missing api key with the reference error body', async () => {
    const response = await request(app()).get('/webhook/find/acme').expect(401);

    expect(response.body).toEqual(unauthorized);
  });

  it('rejects a wrong api key', async () => {
    await request(app()).get('/webhook/find/acme').set('apikey', 'nope').expect(401);
  });

  // A body express.json() cannot parse is the caller's problem, not a 500.
  it('rejects a malformed json body as a client error', async () => {
    const response = await request(app())
      .post('/webhook/set/acme')
      .set('apikey', API_KEY)
      .set('content-type', 'application/json')
      .send('{')
      .expect(400);

    expect(response.body).toEqual({
      status: 400,
      error: 'Bad Request',
      response: { message: 'Request body is not valid JSON' },
    });
  });

  it('answers unmounted routes with json, not html', async () => {
    const response = await request(app()).get('/webhook/nope').set('apikey', API_KEY).expect(404);

    expect(response.body).toEqual({
      status: 404,
      error: 'Not Found',
      response: { message: ['Cannot GET /webhook/nope'] },
    });
  });

  it('leaves the html routes on cookie auth', async () => {
    await request(app()).get('/dashboard').set('apikey', API_KEY).expect(302).expect('Location', '/login');
  });
});
