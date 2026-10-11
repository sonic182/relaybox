import { describe, expect, it } from 'vitest';
import { toArray } from '../../src/forms';

describe('toArray', () => {
  it('normalizes the shapes an urlencoded body can produce', () => {
    expect(toArray(undefined)).toEqual([]);
    expect(toArray('MESSAGES_UPSERT')).toEqual(['MESSAGES_UPSERT']);
    expect(toArray(['MESSAGES_UPSERT', 'CONNECTION_UPDATE'])).toEqual([
      'MESSAGES_UPSERT',
      'CONNECTION_UPDATE',
    ]);
  });

  it('keeps an empty string, which is a submitted field rather than a missing one', () => {
    expect(toArray('')).toEqual(['']);
  });
});
