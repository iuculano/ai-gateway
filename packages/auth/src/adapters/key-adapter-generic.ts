import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { db, eq } from '@repo/drizzle';
import { type ApiKeyRow, apiKeys } from '@repo/drizzle/schemas';
import type { CallerIdentity, KeyAuthAdapter } from '@repo/hono';
import { consumeFixedWindowCounter, redis } from '@repo/redis';
import { HTTPException } from 'hono/http-exception';
import { getOrganization } from '../organizations';
import { getUserById } from '../users';

// Structural shape of a plaintext key - lets us reject garbage before
// paying for a hash + database lookup.
const DEFAULT_KEY_PATTERN = /^aik_[a-zA-Z0-9]{60}$/;

export interface GenericKeyAdapterOptions {
  keyPattern?: RegExp;
}

// Base key shape, except the hash - will never be touched.
type ApiKey = Omit<ApiKeyRow, 'key_hash'>;

// A key that has passed validation, creator is known to exist.
type ValidApiKey = ApiKey & { creator_id: string };

type AddressFamily = 'ipv4' | 'ipv6';

interface ParsedAddress {
  address: string;
  family: AddressFamily;
}

function parseAddress(address: string): ParsedAddress | null {
  const version = isIP(address);
  if (version === 4) {
    return { address, family: 'ipv4' };
  }
  if (version === 6) {
    return { address, family: 'ipv6' };
  }
  return null;
}

/** Both Bun and reverse proxies commonly surface IPv4 peers as mapped IPv6. */
function addressCandidates(address: string): ParsedAddress[] {
  const candidates: ParsedAddress[] = [];
  const parsed = parseAddress(address);
  if (parsed) {
    candidates.push(parsed);
  }

  const mappedPrefix = '::ffff:';
  if (address.toLowerCase().startsWith(mappedPrefix)) {
    const mapped = parseAddress(address.slice(mappedPrefix.length));
    if (mapped) {
      candidates.push(mapped);
    }
  }

  return candidates;
}

function cidrContains(cidr: string, addresses: ParsedAddress[]): boolean {
  const separator = cidr.lastIndexOf('/');
  const networkText = separator >= 0 ? cidr.slice(0, separator) : cidr;
  const network = parseAddress(networkText);
  if (!network) {
    throw new Error(`Invalid CIDR stored for API key: ${cidr}`);
  }

  const maxPrefix = network.family === 'ipv4' ? 32 : 128;
  const prefix = separator >= 0 ? Number(cidr.slice(separator + 1)) : maxPrefix;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
    throw new Error(`Invalid CIDR prefix stored for API key: ${cidr}`);
  }

  const blockList = new BlockList();
  blockList.addSubnet(network.address, prefix, network.family);

  return addresses.some(
    (candidate) => candidate.family === network.family && blockList.check(candidate.address, candidate.family),
  );
}

/** Rejects allowlisted keys when the request peer is missing or outside every configured CIDR. */
function enforceAllowedIp(apiKey: ApiKey, ipAddress?: string): void {
  if (!apiKey.allowed_ips?.length) {
    return;
  }

  const addresses = ipAddress ? addressCandidates(ipAddress) : [];
  const allowed = addresses.length > 0 && apiKey.allowed_ips.some((cidr) => cidrContains(cidr, addresses));
  if (!allowed) {
    throw new HTTPException(401, {
      cause: 'Invalid API key: source IP is not allowed',
    });
  }
}

/**
 * Gets an API key by its SHA-256 hash.
 *
 * This is intentionally the one cross-organization API-key query: the row
 * being looked up is what determines the tenant, so there is no organization
 * to filter by until after it returns.
 *
 * Scoped as tightly as the mechanism allows: one indexed lookup by hash, and
 * the caller must already hold the key to produce that hash.
 *
 * Returns undefined if no matching row is found.
 */
async function getApiKeyByHash(keyHash: string): Promise<ApiKey | undefined> {
  // biome-ignore format: please biome stop fucking with this
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.key_hash, keyHash)).limit(1);

  if (!row) {
    return undefined;
  }

  // wtf is this syntax, why can I create a variable like this? gross
  const { key_hash, ...apiKey } = row;
  return apiKey;
}

/**
 * Finds and validates an API key.
 */
async function validateApiKey(key: string): Promise<ValidApiKey> {
  const hash = createHash('sha256').update(key).digest('hex');
  const apiKey = await getApiKeyByHash(hash);

  if (!apiKey) {
    throw new HTTPException(401, {
      cause: 'Invalid API key: not found',
    });
  }

  if (apiKey.revoked_at) {
    throw new HTTPException(401, {
      cause: 'Invalid API key: revoked',
    });
  }

  if (apiKey.expires_at && apiKey.expires_at.getTime() <= Date.now()) {
    throw new HTTPException(401, {
      cause: 'Invalid API key: expired',
    });
  }

  // If we have a null creator id then the user's already nuked, the key is
  // invalid because it's orphaned.
  const { creator_id } = apiKey;
  if (!creator_id) {
    throw new HTTPException(401, {
      cause: 'Invalid API key: creator not found (no owning user)',
    });
  }

  return { ...apiKey, creator_id };
}


/**
 * Enforces the key's own fixed-window quota.
 *
 * Keys without rate_limit_requests are unlimited.
 */
async function enforceKeyQuota(apiKey: ApiKey): Promise<void> {
  // TODO maybe change how this is stored in the db...?

  // Bail early if either doesn't have a sane number.
  if (apiKey.rate_limit_requests == null || apiKey.rate_limit_window == null) {
    return;
  }

  const windowSeconds = apiKey.rate_limit_window;

  const quotaKey = `api-keys:quota:${apiKey.id}`;
  const quota = await consumeFixedWindowCounter(quotaKey, {
    limit: apiKey.rate_limit_requests,
    windowSeconds: windowSeconds,
  });

  if (quota.isLimited) {
    throw new HTTPException(429, {
      res: new Response(null, {
        headers: {
          'Retry-After': String(quota.retryAfterSeconds),
          'RateLimit': `limit=${quota.limit}, remaining=${quota.remainingQuota}, reset=${quota.retryAfterSeconds}`,
          'RateLimit-Policy': `${quota.limit};w=${windowSeconds}`,
        },
      }),
    });
  }
}

/**
 * Updates the key's usage stats.
 */
async function recordApiKeyUsage(apiKeyId: string): Promise<void> {
  const usageKey = `api-keys:usage:${apiKeyId}`;

  // biome-ignore format: please biome leave this alone, i like it this way
  await redis
    .multi()
    .hIncrBy(usageKey, 'total_requests', 1)
    .hSet(usageKey, 'last_used_at', Date.now())
    .exec();
}

/**
 * Resolves the key's organization and owning user into a Caller identity.
 *
 */
async function buildCaller(apiKey: ValidApiKey): Promise<CallerIdentity> {
  // Key needs to be scoped to an organization, field is guaranteed.
  const organization = await getOrganization(apiKey.organization_id);
  if (!organization) {
    throw new HTTPException(401, {
      cause: 'Invalid API key: organization not found',
    });
  }

  if (organization.status !== 'active') {
    throw new HTTPException(401, {
      cause: 'Invalid API key: organization is not active',
    });
  }

  const user = await getUserById(apiKey.creator_id);
  if (!user) {
    throw new HTTPException(401, {
      cause: 'Invalid API key: creator not found',
    });
  }

  // Read fresh on every authentication attempt, so deletion is immediate.
  if (user.status !== 'active') {
    throw new HTTPException(401, {
      cause: 'Invalid API key: creator is not active',
    });
  }

  return {
    organization: {
      id: apiKey.organization_id,
      name: organization.name,
    },

    actor: {
      type: 'api_key',
      key: {
        id: apiKey.id,
        name: apiKey.name,
      },
      owner: {
        id: apiKey.creator_id,
        username: user.username,
        email: user.email ?? user.username,
        displayName: user.name ?? undefined,
      },
    },

    permissions: {
      scopes: apiKey.scopes.split(' ').filter(Boolean),
    },
  };
}

/**
 * Builds an adapter for opaque aik_ API keys: hashes the presented key, loads
 * and validates the matching row, enforces its source-IP allowlist and quota,
 * records usage, and resolves the owning organization and user.
 */
export function createGenericKeyAdapter(options: GenericKeyAdapterOptions = {}): KeyAuthAdapter {
  const keyPattern = options.keyPattern ?? DEFAULT_KEY_PATTERN;

  return async ({ key, request }) => {
    // Early out if the key is blatantly malformed, skips needing an actual
    // database lookup.
    if (!keyPattern.test(key)) {
      throw new HTTPException(401, {
        cause: 'Invalid API key: malformed',
      });
    }

    const apiKey = await validateApiKey(key);
    enforceAllowedIp(apiKey, request.ipAddress);

    // Resolve status before consuming quota or recording usage: a suspended
    // tenant or owner did not make an authenticated request.
    const caller = await buildCaller(apiKey);

    await enforceKeyQuota(apiKey);
    await recordApiKeyUsage(apiKey.id);

    return caller;
  };
}
