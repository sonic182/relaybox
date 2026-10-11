import { describe, expect, it } from 'vitest';
import { MCP_MEDIA_BASE_URL, MCP_MEDIA_URL_TTL } from '../../src/config';
import { buildMediaUrl, verifyMediaSignature } from '../../src/mediaAccess';

function parts(url: string) {
  const parsed = new URL(url);
  return {
    exp: parsed.searchParams.get('exp') ?? undefined,
    sig: parsed.searchParams.get('sig') ?? undefined,
  };
}

describe('signed media URLs', () => {
  it('builds links on the MCP media base URL', () => {
    expect(buildMediaUrl('acme', 'm1').url.startsWith(new URL(MCP_MEDIA_BASE_URL).origin)).toBe(true);
  });

  it('accepts a freshly built token', () => {
    const { exp, sig } = parts(buildMediaUrl('acme', 'm1').url);
    expect(verifyMediaSignature('acme', 'm1', exp, sig)).toBe(true);
  });

  it('rejects an expired token', () => {
    // `buildMediaUrl` adds the TTL to `now`, so start well past it to land in the past.
    const { exp, sig } = parts(buildMediaUrl('acme', 'm1', Date.now() - (MCP_MEDIA_URL_TTL + 60) * 1000).url);
    expect(verifyMediaSignature('acme', 'm1', exp, sig)).toBe(false);
  });

  it('rejects a token reused for another message', () => {
    const { exp, sig } = parts(buildMediaUrl('acme', 'm1').url);
    expect(verifyMediaSignature('acme', 'm2', exp, sig)).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const { exp, sig = '' } = parts(buildMediaUrl('acme', 'm1').url);
    const tampered = `${sig.slice(0, -1)}${sig.endsWith('a') ? 'b' : 'a'}`;
    expect(verifyMediaSignature('acme', 'm1', exp, tampered)).toBe(false);
  });
});
