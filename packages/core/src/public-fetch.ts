import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';

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
  ['fe80::', 10], // Link-local, the IPv6 counterpart of 169.254.0.0/16
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
 * address, and returns the address it looked up for a hostname.
 *
 * @param url
 * The URL about to be called.
 */
export async function assertPublicUrl(url: string | URL): Promise<string | undefined> {
  // Useful for local development and testing.
  if (process.env.ALLOW_PRIVATE_NETWORK_URLS === 'true') {
    return undefined;
  }

  const { protocol, hostname } = new URL(url);
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new BlockedUrlError(`URL must be http or https, not ${protocol}`);
  }

  // URL leaves the brackets on IPv6 literals, and isIP doesn't recognise it.
  // Need to strip brackets for it.
  const host = hostname.replace(/^\[|\]$/g, '');
  let addresses: { address: string; family: number }[] = [];

  // 4 or 6 when the URL holds an IP address, 0 for a hostname.
  const ipVersion = isIP(host);
  if (ipVersion) {
    addresses = [{ address: host, family: ipVersion }];
  }

  // Passed a hostname in, need to resolve it.
  if (!ipVersion) {
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

  // An IP in the URL was never looked up, so there's nothing to pin.
  if (ipVersion) {
    return undefined;
  }

  // Prefer an IPv4 address if available.
  for (const { address, family } of addresses) {
    if (family === 4) {
      return address;
    }
  }

  // The host has no IPv4 address, so use its IPv6 one.
  return addresses[0]?.address;
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
  const original = new URL(input instanceof Request ? input.url : input);
  const address = await assertPublicUrl(original);

  // Already checked above - it's a sane IP.
  if (!address) {
    return fetch(input, { ...init, redirect: 'manual' });
  }

  // fetch() would look the host up again, and a second answer could be a private
  // address. Need to connect with the IP we've just checked.
  const pinned = new URL(original);
  pinned.hostname = isIP(address) === 6 ? `[${address}]` : address;

  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set('host', original.host);

  const tls: BunFetchRequestInitTLS | undefined =
    original.protocol === 'https:'
      ? {
          serverName: original.hostname,
          checkServerIdentity: (_address, cert) => checkServerIdentity(original.hostname, cert),
        }
      : undefined;

  return fetch(input instanceof Request ? new Request(pinned.href, input) : pinned, {
    ...init,
    headers,
    redirect: 'manual',
    tls,
  });
}

// AI SDK seemingly types their fetch option this way.
// Just doing export async function publicFetch() does NOT work.
export const publicFetch = guardedFetch as typeof fetch;
