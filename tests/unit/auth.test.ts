import { describe, expect, it } from 'vitest';
import { isValidToken } from '../../src/auth';

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
