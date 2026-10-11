import { describe, expect, it } from 'vitest';
import { parseApiKey, parseMcpPath, parseNonNegativeInt, parsePositiveInt, parseRemoteTarget } from '../../src/config';

describe('parsePositiveInt', () => {
  it('parses a positive integer and falls back when unset', () => {
    expect(parsePositiveInt('N', '8', 4)).toBe(8);
    expect(parsePositiveInt('N', undefined, 4)).toBe(4);
    expect(parsePositiveInt('N', '  ', 4)).toBe(4);
  });

  it('rejects zero, negatives, and non-integers', () => {
    for (const value of ['0', '-1', '1.5', 'nope']) {
      expect(() => parsePositiveInt('N', value, 4)).toThrow('N must be a positive integer');
    }
  });
});

describe('parseApiKey', () => {
  it('accepts a key of at least 16 characters', () => {
    expect(parseApiKey('0123456789abcdef')).toBe('0123456789abcdef');
  });

  it('rejects a missing, short, or placeholder key', () => {
    expect(() => parseApiKey(undefined)).toThrow('API_KEY env var is required');
    expect(() => parseApiKey('short-key')).toThrow('at least 16 characters');
    expect(() => parseApiKey('changeme-api-key')).toThrow('placeholder');
  });
});

describe('MCP configuration', () => {
  it('defaults blank inline caps but preserves an explicit zero', () => {
    expect(parseNonNegativeInt('N', ' ', 4)).toBe(4);
    expect(parseNonNegativeInt('N', '0', 4)).toBe(0);
    expect(() => parseNonNegativeInt('N', '-1', 4)).toThrow();
  });

  it('accepts literal mount paths and rejects root, patterns and reserved namespaces', () => {
    expect(parseMcpPath(undefined)).toBe('/mcp');
    expect(parseMcpPath('/tools/mcp')).toBe('/tools/mcp');
    for (const path of [
      '/', 'mcp', '/mcp/', '/:name', '/dev/mcp', '/mcp?x=1',
      '/chat/mcp', '/CHAT/mcp', '/instance/mcp', '/message/mcp', '/webhook/mcp',
      '/instances', '/media/tools', '/dashboard', '/login', '/logout', '/redoc', '/ui',
    ]) {
      expect(() => parseMcpPath(path)).toThrow('MCP_PATH');
    }
  });
});

describe('parseRemoteTarget', () => {
  it('stays off when both are unset, but flags a token with no URL', () => {
    expect(parseRemoteTarget(undefined, undefined)).toEqual({});
    expect(parseRemoteTarget('  ', ' ')).toEqual({});
    expect(parseRemoteTarget(undefined, 't')).toEqual({ error: 'REMOTE_SERVER_TOKEN is set without REMOTE_SERVER_URL' });
  });

  it('rejects a URL carrying credentials so the token stays the only one', () => {
    const result = parseRemoteTarget('wss://user:s3cret@target.example', 'secret');
    expect(result.error).toContain('must not contain credentials');
    expect(result.target).toBeUndefined();
  });

  it('rejects a fragment, which the ws constructor throws on', () => {
    const result = parseRemoteTarget('wss://target.example/path#frag', 'secret');
    expect(result.error).toContain('must not contain a fragment');
    expect(result.target).toBeUndefined();
  });

  it('disables the feature on an invalid URL, a non-ws scheme, or a missing token', () => {
    expect(parseRemoteTarget('not a url', 't')).toEqual({ error: 'REMOTE_SERVER_URL is not a valid URL' });
    expect(parseRemoteTarget('http://target.example', 't')).toEqual({ error: 'REMOTE_SERVER_URL must use ws:// or wss://' });
    expect(parseRemoteTarget('wss://target.example', ' ').error).toContain('REMOTE_SERVER_TOKEN');
  });

  it('accepts wss and local ws targets', () => {
    for (const url of ['wss://target.example', 'ws://localhost:4000', 'ws://192.168.1.5', 'ws://box.local', 'ws://[::1]:4000', 'ws://[::ffff:192.168.1.5]']) {
      const result = parseRemoteTarget(url, 'secret');
      expect(result.target?.token).toBe('secret');
      expect(result.error).toBeUndefined();
    }
  });

  it('rejects plain ws to a public host without leaking the token', () => {
    const result = parseRemoteTarget('ws://target.example/path', 'secret');
    expect(result.target).toBeUndefined();
    expect(result.error).toContain('target.example');
    expect(result.error).not.toContain('secret');
  });
});
