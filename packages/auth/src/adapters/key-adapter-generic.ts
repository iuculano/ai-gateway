import { createHash } from 'node:crypto';
import { db, eq } from '@repo/drizzle';
import { type ApiKeyRow, apiKeys } from '@repo/drizzle/schemas';
import type { CallerIdentity, KeyAuthAdapter } from '@repo/hono/auth-adapter';
import { consumeFixedWindowCounter, redis } from '@repo/redis';
import { HTTPException } from 'hono/http-exception';
import { getOrganization } from '../organizations';
import { getUserById } from '../users';

// Structural shape of a plaintext key - lets us reject garbage before
// paying for a hash + database lookup.
const DEFAULT_KEY_PATTERN = /^aik_[a-zA-Z0-9]{60}$/;
const AUTH_CACHE_PREFIX = 'api-keys:auth:v1:';

/**
 * Options for the generic key adapter.
 */
export interface GenericKeyAdapterOptions {
  /** Regex pattern for the expected API key format. */
  keyPattern?: RegExp;

  /** Redis authorization-cache lifetime in seconds. Set to 0 to disable. */
  cacheTtlSeconds?: number;
}

// Base key shape, except the hash - will never be touched.
type ApiKey = Omit<ApiKeyRow, 'key_hash'>;

// A key that has passed validation, creator is known to exist.
type ValidApiKey = ApiKey & { creator_id: string };

interface CachedKeyAuthorization {
  version: 1;
  key: {
    id: string;
    rateLimitRequests: number | null;
    rateLimitWindow: number | null;
    expiresAtMs: number | null;
  };
  caller: {
    organizationId: string;
    organizationName: string;
    keyName: string;
    ownerId: string;
    ownerUsername: string;
    ownerEmail: string;
    ownerDisplayName: string | null;
    scopes: string[];
  };
}

type QuotaApiKey = Pick<ApiKey, 'id' | 'rate_limit_requests' | 'rate_limit_window'>;

function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function authCacheKey(keyHash: string): string {
  return `${AUTH_CACHE_PREFIX}${keyHash}`;
}

/** Evicts the authorization snapshot associated with an API-key hash. */
export async function invalidateGenericKeyAuthCache(keyHash: string): Promise<void> {
  await redis.del(authCacheKey(keyHash));
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isCachedKeyAuthorization(value: unknown): value is CachedKeyAuthorization {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const cached = value as Partial<CachedKeyAuthorization>;
  const key = cached.key as Partial<CachedKeyAuthorization['key']> | undefined;
  const caller = cached.caller as Partial<CachedKeyAuthorization['caller']> | undefined;

  return (
    cached.version === 1 &&
    typeof key?.id === 'string' &&
    isNullableNumber(key.rateLimitRequests) &&
    isNullableNumber(key.rateLimitWindow) &&
    isNullableNumber(key.expiresAtMs) &&
    typeof caller?.organizationId === 'string' &&
    typeof caller.organizationName === 'string' &&
    typeof caller.keyName === 'string' &&
    typeof caller.ownerId === 'string' &&
    typeof caller.ownerUsername === 'string' &&
    typeof caller.ownerEmail === 'string' &&
    (caller.ownerDisplayName === null || typeof caller.ownerDisplayName === 'string') &&
    Array.isArray(caller.scopes) &&
    caller.scopes.every((scope) => typeof scope === 'string')
  );
}

function parseCachedKeyAuthorization(value: string | null): CachedKeyAuthorization | null {
  if (!value) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    return isCachedKeyAuthorization(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toCaller(cached: CachedKeyAuthorization): CallerIdentity {
  return {
    organization: {
      id: cached.caller.organizationId,
      name: cached.caller.organizationName,
    },
    actor: {
      type: 'api_key',
      key: {
        id: cached.key.id,
        name: cached.caller.keyName,
      },
      owner: {
        id: cached.caller.ownerId,
        username: cached.caller.ownerUsername,
        email: cached.caller.ownerEmail,
        displayName: cached.caller.ownerDisplayName ?? undefined,
      },
    },
    permissions: {
      scopes: cached.caller.scopes,
    },
  };
}

function toCachedKeyAuthorization(apiKey: ValidApiKey, caller: CallerIdentity): CachedKeyAuthorization {
  if (caller.actor.type !== 'api_key') {
    throw new Error('Generic API-key adapter built a non-key caller');
  }

  return {
    version: 1,
    key: {
      id: apiKey.id,
      rateLimitRequests: apiKey.rate_limit_requests,
      rateLimitWindow: apiKey.rate_limit_window,
      expiresAtMs: apiKey.expires_at?.getTime() ?? null,
    },
    caller: {
      organizationId: caller.organization.id,
      organizationName: caller.organization.name,
      keyName: caller.actor.key.name,
      ownerId: caller.actor.owner.id,
      ownerUsername: caller.actor.owner.username,
      ownerEmail: caller.actor.owner.email,
      ownerDisplayName: caller.actor.owner.displayName ?? null,
      scopes: [...caller.permissions.scopes],
    },
  };
}

/**
 * Gets an API key by its SHA-256 hash.
 *
 * This is intentionally the one cross-organization API-key query. The row
 * being looked up is what determines the tenant, so there is no organization
 * to filter by until after it returns.
 *
 * Returns undefined if no matching row is found.
 */
async function getApiKeyByHash(keyHash: string): Promise<ApiKey | undefined> {
  // biome-ignore format: please biome stop fucking with this
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.key_hash, keyHash))
    .limit(1);

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
async function validateApiKeyHash(keyHash: string): Promise<ValidApiKey> {
  const apiKey = await getApiKeyByHash(keyHash);

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
 * Keys without rate_limit_requests or rate_limit_window are unlimited.
 */
async function enforceKeyQuota(apiKey: QuotaApiKey): Promise<void> {
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
          RateLimit: `limit=${quota.limit}, remaining=${quota.remainingQuota}, reset=${quota.retryAfterSeconds}`,
          'RateLimit-Policy': `${quota.limit};w=${windowSeconds}`,
        },
      }),
    });
  }
}

/**
 * Updates the key's usage stats in Redis.
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
 * Builds an adapter for validating generic API keys.
 */
export function createGenericKeyAdapter(options: GenericKeyAdapterOptions = {}): KeyAuthAdapter {
  const keyPattern = options.keyPattern ?? DEFAULT_KEY_PATTERN;
  const cacheTtlSeconds = options.cacheTtlSeconds ?? 0;

  if (!Number.isInteger(cacheTtlSeconds) || cacheTtlSeconds < 0) {
    throw new RangeError('API-key auth cache TTL must be a non-negative integer');
  }

  // `api_keys.allowed_ips` is reserved configuration for a future feature. IP
  // allowlisting is intentionally unsupported here today, so the request's peer
  // address is not consumed and callers must not rely on allowed_ips for access
  // control. Keep this explicit so the stored-but-unused field is not mistaken
  // for an accidentally omitted security check.
  return async ({ key }) => {
    // Early out if the key is blatantly malformed, skips needing an actual
    // database lookup.
    if (!keyPattern.test(key)) {
      throw new HTTPException(401, {
        cause: 'Invalid API key: malformed',
      });
    }

    const keyHash = hashApiKey(key);
    const cacheKey = authCacheKey(keyHash);
    let cached = cacheTtlSeconds > 0 ? parseCachedKeyAuthorization(await redis.get(cacheKey)) : null;

    // A Redis entry can outlive the credential's own expiry by less than one
    // second because cache TTLs are integer seconds. Never let that rounding
    // extend the key's validity.
    if (cached?.key.expiresAtMs != null && cached.key.expiresAtMs <= Date.now()) {
      await redis.del(cacheKey);
      cached = null;
    }

    let quotaApiKey: QuotaApiKey;
    let caller: CallerIdentity;

    if (cached) {
      quotaApiKey = {
        id: cached.key.id,
        rate_limit_requests: cached.key.rateLimitRequests,
        rate_limit_window: cached.key.rateLimitWindow,
      };
      caller = toCaller(cached);
    } else {
      const apiKey = await validateApiKeyHash(keyHash);

      // Resolve status before consuming quota or recording usage: a suspended
      // tenant or owner did not make an authenticated request.
      caller = await buildCaller(apiKey);
      quotaApiKey = apiKey;

      if (cacheTtlSeconds > 0) {
        const expiresInSeconds =
          apiKey.expires_at == null
            ? cacheTtlSeconds
            : Math.max(1, Math.ceil((apiKey.expires_at.getTime() - Date.now()) / 1000));

        await redis.set(cacheKey, JSON.stringify(toCachedKeyAuthorization(apiKey, caller)), {
          expiration: { type: 'EX', value: Math.min(cacheTtlSeconds, expiresInSeconds) },
        });
      }
    }

    // Rate limiting - make sure we enforce before we write usage so it doesn't
    // continue to be incremeneted despite failing.
    await enforceKeyQuota(quotaApiKey);
    await recordApiKeyUsage(quotaApiKey.id);

    return caller;
  };
}
