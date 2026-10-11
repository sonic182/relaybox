import ipaddr from 'ipaddr.js';

function normalize(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

export function isLoopbackHost(hostname: string): boolean {
  const host = normalize(hostname);
  return host === 'localhost' || host.endsWith('.localhost') || (ipaddr.isValid(host) && ipaddr.process(host).range() === 'loopback');
}

/**
 * Ranges an operator can opt into with `ALLOW_PRIVATE_WEBHOOK_TARGETS`. Deliberately not
 * `linkLocal`: 169.254.169.254 is the cloud metadata endpoint, which is the address an SSRF
 * guard exists to protect, and nobody runs a webhook consumer there.
 */
const PRIVATE_RANGES = new Set(['private', 'uniqueLocal']);

/** A literal address on the local network, or a name reserved for one. */
export function isPrivateHost(hostname: string): boolean {
  const host = normalize(hostname);
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;

  return ipaddr.isValid(host) && PRIVATE_RANGES.has(ipaddr.process(host).range());
}

/** Reject names reserved for the local network and literal non-public addresses. */
export function isForbiddenHostname(hostname: string, allowPrivate = false): boolean {
  const host = normalize(hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return !allowPrivate;

  return ipaddr.isValid(host) && isForbiddenIp(host, allowPrivate);
}

/** DNS results must be parseable, public unicast addresses, including mapped IPv4. */
export function isForbiddenIp(ip: string, allowPrivate = false): boolean {
  const value = normalize(ip);
  if (!ipaddr.isValid(value)) return true;

  const range = ipaddr.process(value).range();
  return range !== 'unicast' && !(allowPrivate && PRIVATE_RANGES.has(range));
}
