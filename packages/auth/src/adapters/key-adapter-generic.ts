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

/**
 * Options for the generic key adapter.
 */
export interface GenericKeyAdapterOptions {
  /** Regex pattern for the expected API key format. */
  keyPattern?: RegExp;
}

// Base key shape, except the hash - will never be touched.
type ApiKey = Omit<ApiKeyRow, 'key_hash'>;

// A key that has passed validation, creator is known to exist.
type ValidApiKey = ApiKey & { creator_id: string };

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
 * Keys without rate_limit_requests or rate_limit_window are unlimited.
 */
async function enforceKeyQuota(apiKey: ApiKey): Promise<void> {
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

    const apiKey = await validateApiKey(key);

    // Resolve status before consuming quota or recording usage: a suspended
    // tenant or owner did not make an authenticated request.
    const caller = await buildCaller(apiKey);

    // Rate limiting - make sure we enforce before we write usage so it doesn't
    // continue to be incremeneted despite failing.
    await enforceKeyQuota(apiKey);
    await recordApiKeyUsage(apiKey.id);

    return caller;
  };
}
