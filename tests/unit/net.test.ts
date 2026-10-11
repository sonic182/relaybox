import { describe, expect, it } from 'vitest';
import { isForbiddenHostname, isForbiddenIp, isLoopbackHost, isPrivateHost } from '../../src/net';

describe('network target checks', () => {
  it('rejects local names and non-public IPv4, IPv6, and mapped IPv4 addresses', () => {
    expect(isForbiddenHostname('api.internal')).toBe(true);
    expect(isForbiddenIp('10.0.0.1')).toBe(true);
    expect(isForbiddenIp('fe90::1')).toBe(true);
    expect(isForbiddenIp('::ffff:169.254.169.254')).toBe(true);
    expect(isForbiddenIp('8.8.8.8')).toBe(false);
  });

  it('opens up the local network when the operator opts in, but never link-local', () => {
    expect(isForbiddenIp('10.0.0.1', true)).toBe(false);
    expect(isForbiddenIp('192.168.1.153', true)).toBe(false);
    expect(isForbiddenIp('172.16.0.1', true)).toBe(false);
    expect(isForbiddenIp('[fd00::1]', true)).toBe(false);
    expect(isForbiddenHostname('printer.local', true)).toBe(false);
    // Cloud instance metadata is the address the guard exists for.
    expect(isForbiddenIp('169.254.169.254', true)).toBe(true);
    expect(isForbiddenIp('::ffff:169.254.169.254', true)).toBe(true);
    expect(isForbiddenHostname('localhost', true)).toBe(false);
    expect(isForbiddenIp('127.0.0.1', true)).toBe(false);
    expect(isForbiddenHostname('localhost')).toBe(true);
    expect(isForbiddenIp('127.0.0.1')).toBe(true);
  });

  it('identifies hosts on the local network', () => {
    expect(isPrivateHost('192.168.1.153')).toBe(true);
    expect(isPrivateHost('10.1.2.3')).toBe(true);
    expect(isPrivateHost('printer.local')).toBe(true);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('169.254.169.254')).toBe(false);
  });

  it('recognizes configured loopback callbacks', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
  });
});
