import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isValidSession, isValidToken, sessionToken } from '../../src/auth';
import { SESSION_TTL_SECONDS } from '../../src/config';

const TEST_TOKEN = 'test-api-key-0000';

describe('isValidToken', () => {
  it('accepts the configured token', () => {
    expect(isValidToken(TEST_TOKEN)).toBe(true);
  });

  it.each([undefined, '', 'wrong-token', `${TEST_TOKEN}-extra`])(
    'rejects an invalid token: %j',
    (token) => {
      expect(isValidToken(token)).toBe(false);
    },
  );
});

describe('isValidSession', () => {
  const issuedAt = 1_760_000_000_000;
  const ttlMs = SESSION_TTL_SECONDS * 1000;

  it('accepts a token until it expires', () => {
    const token = sessionToken(issuedAt);

    expect(isValidSession(token, issuedAt)).toBe(true);
    expect(isValidSession(token, issuedAt + ttlMs - 1)).toBe(true);
    expect(isValidSession(token, issuedAt + ttlMs)).toBe(false);
  });

  it('rejects a token issued in the future', () => {
    expect(isValidSession(sessionToken(issuedAt + 5 * 60_000), issuedAt)).toBe(false);
  });

  it('rejects a token whose issue time was changed', () => {
    const signature = sessionToken(issuedAt).split('.')[1];

    expect(isValidSession(`${issuedAt + 1000}.${signature}`, issuedAt + 1000)).toBe(false);
  });

  it('rejects the pre-expiry session format', () => {
    const legacy = createHmac('sha256', TEST_TOKEN).update('dashboard-session').digest('hex');

    expect(isValidSession(legacy, issuedAt)).toBe(false);
    expect(isValidSession(undefined, issuedAt)).toBe(false);
  });
});
