import { createHash } from 'node:crypto';
import { db, eq, sql } from '@repo/drizzle';
import { apiKeys, organizations, users } from '@repo/drizzle/schemas';
import { getLogger } from '@repo/hono';
import type { CallerIdentity, KeyAuthAdapter } from '@repo/hono/auth-adapter';
import { consumeFixedWindowCounter, redis } from '@repo/redis';
import { HTTPException } from 'hono/http-exception';

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

interface QuotaApiKey {
  id: string;
  rate_limit_requests: number | null;
  rate_limit_window: number | null;
}

interface ResolvedApiKeyAuthorization {
  apiKey: QuotaApiKey;
  caller: CallerIdentity;
}

function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function prepareKeyLookup() {
  return db
    .select({
      apiKey: {
        id: apiKeys.id,
        organizationId: apiKeys.organization_id,
        name: apiKeys.name,
        creatorId: apiKeys.creator_id,
        scopes: apiKeys.scopes,
        rateLimitRequests: apiKeys.rate_limit_requests,
        rateLimitWindow: apiKeys.rate_limit_window,
        expiresAt: apiKeys.expires_at,
        revokedAt: apiKeys.revoked_at,
      },
      organization: {
        id: organizations.id,
        name: organizations.name,
        status: organizations.status,
      },
      owner: {
        id: users.id,
        username: users.username,
        email: users.email,
        displayName: users.name,
        status: users.status,
      },
    })
    .from(apiKeys)
    .innerJoin(organizations, eq(apiKeys.organization_id, organizations.id))
    .leftJoin(users, eq(apiKeys.creator_id, users.id))
    .where(eq(apiKeys.key_hash, sql.placeholder('keyHash')))
    .prepare('resolve_api_key_authorization');
}

let keyLookup: ReturnType<typeof prepareKeyLookup> | undefined;

async function resolveApiKeyAuthorization(keyHash: string): Promise<ResolvedApiKeyAuthorization> {
  keyLookup ??= prepareKeyLookup();
  const [row] = await keyLookup.execute({ keyHash });

  if (!row) {
    throw new HTTPException(401, {
      cause: 'Invalid API key: not found',
    });
  }

  const { apiKey, organization, owner } = row;

  if (apiKey.revokedAt) {
    throw new HTTPException(401, {
      cause: 'Invalid API key: revoked',
    });
  }

  if (apiKey.expiresAt && apiKey.expiresAt.getTime() <= Date.now()) {
    throw new HTTPException(401, {
      cause: 'Invalid API key: expired',
    });
  }

  if (!apiKey.creatorId) {
    throw new HTTPException(401, {
      cause: 'Invalid API key: creator not found (no owning user)',
    });
  }

  // TODO: Integrate these gates with the future user/tenant suspension lifecycle.
  if (organization.status !== 'active') {
    throw new HTTPException(401, {
      cause: 'Invalid API key: organization is not active',
    });
  }

  if (!owner) {
    throw new HTTPException(401, {
      cause: 'Invalid API key: creator not found',
    });
  }

  if (owner.status !== 'active') {
    throw new HTTPException(401, {
      cause: 'Invalid API key: creator is not active',
    });
  }

  return {
    apiKey: {
      id: apiKey.id,
      rate_limit_requests: apiKey.rateLimitRequests,
      rate_limit_window: apiKey.rateLimitWindow,
    },
    caller: {
      organization: {
        id: apiKey.organizationId,
        name: organization.name,
      },
      actor: {
        type: 'api_key',
        key: {
          id: apiKey.id,
          name: apiKey.name,
        },
        owner: {
          id: owner.id,
          username: owner.username,
          email: owner.email ?? owner.username,
          displayName: owner.displayName ?? undefined,
        },
      },
      permissions: {
        scopes: apiKey.scopes.split(' ').filter(Boolean),
      },
    },
  };
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

const USAGE_FLUSH_MS = 1_000;

const pendingUsage = new Map<string, { requests: number; lastUsedAt: number }>();
let usageTimer: Timer | undefined;

function recordApiKeyUsage(apiKeyId: string): void {
  const usage = pendingUsage.get(apiKeyId) ?? { requests: 0, lastUsedAt: 0 };
  usage.requests += 1;
  usage.lastUsedAt = Date.now();
  pendingUsage.set(apiKeyId, usage);

  usageTimer ??= setTimeout(flushApiKeyUsage, USAGE_FLUSH_MS);
}

/**
 * Writes the buffered usage counts to Redis.
 */
export async function flushApiKeyUsage(): Promise<void> {
  clearTimeout(usageTimer);
  usageTimer = undefined;
  if (pendingUsage.size === 0) {
    return;
  }

  const multi = redis.multi();
  for (const [apiKeyId, usage] of pendingUsage) {
    const usageKey = `api-keys:usage:${apiKeyId}`;
    multi.hIncrBy(usageKey, 'total_requests', usage.requests).hSet(usageKey, 'last_used_at', usage.lastUsedAt);
  }
  pendingUsage.clear();

  try {
    await multi.exec();
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to write API key usage');
  }
}

/**
 * Builds an adapter for validating generic API keys.
 */
export function createGenericKeyAdapter(options: GenericKeyAdapterOptions = {}): KeyAuthAdapter {
  const keyPattern = options.keyPattern ?? DEFAULT_KEY_PATTERN;

  // TODO: Enforce legacy allowed_ips values once trusted proxy handling exists.
  return async ({ key }) => {
    // Early out if the key is blatantly malformed, skips needing an actual
    // database lookup.
    if (!keyPattern.test(key)) {
      throw new HTTPException(401, {
        cause: 'Invalid API key: malformed',
      });
    }

    const keyHash = hashApiKey(key);
    const { apiKey, caller } = await resolveApiKeyAuthorization(keyHash);

    // Rate limiting - make sure we enforce before we write usage so it doesn't
    // continue to be incremeneted despite failing.
    await enforceKeyQuota(apiKey);
    recordApiKeyUsage(apiKey.id);

    return caller;
  };
}
