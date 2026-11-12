import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blockList = new BlockList();

const IPV4_RANGES = [
  ['0.0.0.0', 8], // This network
  ['10.0.0.0', 8], // Private networks
  ['100.64.0.0', 10], // Some cloud metadata services?
  ['127.0.0.0', 8], // Loopback
  ['169.254.0.0', 16], // Link-local / reserved - some cloud metadata may use this?
  ['172.16.0.0', 12], // Private networks
  ['192.168.0.0', 16], // Private networks
] as const;

const IPV6_RANGES = [
  ['::', 127], // Unspecified and loopback, :: and ::1
  ['64:ff9b::', 96], // NAT64, which reaches IPv4 addresses
  ['fc00::', 7], // Unique local, the IPv6 private networks
] as const;

for (const [network, prefix] of IPV4_RANGES) {
  blockList.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of IPV6_RANGES) {
  blockList.addSubnet(network, prefix, 'ipv6');
}

export class BlockedUrlError extends Error {
  override name = 'BlockedUrlError';
}

/**
 * Refuses a caller-supplied URL that points to a private or reserved network
 * address.
 *
 * @param url
 * The URL about to be called.
 */
export async function assertPublicUrl(url: string | URL): Promise<void> {
  // Useful for local development and testing.
  if (process.env.ALLOW_PRIVATE_NETWORK_URLS === 'true') {
    return;
  }

  const { protocol, hostname } = new URL(url);
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new BlockedUrlError(`URL must be http or https, not ${protocol}`);
  }

  // URL leaves the brackets on IPv6 literals, and isIP doesn't recognise it.
  // Need to strip brackets for it.
  const host = hostname.replace(/^\[|\]$/g, '');
  let addresses: { address: string; family: number }[] = [];

  // If it's a direct IP...
  const family = isIP(host);
  if (family) {
    addresses = [{ address: host, family }];
  }

  // Passed a hostname in, need to resolve it.
  if (!family) {
    try {
      addresses = await lookup(host, { all: true });
    } catch {
      throw new BlockedUrlError(`Host '${host}' could not be resolved`);
    }
  }

  // Finally check against the blocklist.
  for (const { address, family } of addresses) {
    if (blockList.check(address, family === 6 ? 'ipv6' : 'ipv4')) {
      throw new BlockedUrlError(`Host '${host}' is not a public address`);
    }
  }
}

/**
 * fetch() for URLs a caller supplied. Refuses private addresses.
 *
 * @param input
 * The URL or request to fetch.
 *
 * @param init
 * The usual fetch options.
 */
export async function guardedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  await assertPublicUrl(input instanceof Request ? input.url : input);
  return fetch(input, { ...init, redirect: 'manual' });
}

// AI SDK seemingly types their fetch option this way.
// Just doing export async function publicFetch() does NOT work.
export const publicFetch = guardedFetch as typeof fetch;
