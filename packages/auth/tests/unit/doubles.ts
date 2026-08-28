import { afterEach, mock } from 'bun:test';
import { createDatabaseDouble, failsWith, KEY_ID, ORGANIZATION_ID, rows, USER_ID } from '@repo/test-helpers';

export { failsWith, rows };

const { database, db } = createDatabaseDouble();

export { database };

afterEach(() => {
  database.assertResponsesConsumed();
});

export const quota = {
  calls: [] as { key: string; policy: { limit: number; windowSeconds: number; incrementBy?: number } }[],
  failure: null as Error | null,
  response: {
    limit: 10,
    isLimited: false,
    remainingQuota: 9,
    retryAfterSeconds: null as number | null,
    delaySeconds: null,
  },

  reset() {
    quota.calls = [];
    quota.failure = null;
    quota.response = {
      limit: 10,
      isLimited: false,
      remainingQuota: 9,
      retryAfterSeconds: null,
      delaySeconds: null,
    };
  },
};

async function consumeFixedWindowCounter(
  key: string,
  policy: { limit: number; windowSeconds: number; incrementBy?: number },
) {
  quota.calls.push({ key, policy });
  if (quota.failure) {
    throw quota.failure;
  }

  return quota.response;
}

export const usage = {
  pipelines: [] as { method: string; args: unknown[] }[][],
  failure: null as Error | null,

  reset() {
    usage.pipelines = [];
    usage.failure = null;
  },
};

export const authCache = {
  values: new Map<string, string>(),
  gets: [] as string[],
  sets: [] as { key: string; value: string; options: unknown }[],
  deletes: [] as string[],

  reset() {
    authCache.values.clear();
    authCache.gets = [];
    authCache.sets = [];
    authCache.deletes = [];
  },
};

const redis = {
  async get(key: string) {
    authCache.gets.push(key);
    return authCache.values.get(key) ?? null;
  },
  async set(key: string, value: string, options: unknown) {
    authCache.sets.push({ key, value, options });
    authCache.values.set(key, value);
    return 'OK';
  },
  async del(key: string) {
    authCache.deletes.push(key);
    return authCache.values.delete(key) ? 1 : 0;
  },
  multi() {
    const operations: { method: string; args: unknown[] }[] = [];
    const pipeline = {
      hIncrBy(...args: unknown[]) {
        operations.push({ method: 'hIncrBy', args });
        return pipeline;
      },
      hSet(...args: unknown[]) {
        operations.push({ method: 'hSet', args });
        return pipeline;
      },
      async exec() {
        usage.pipelines.push(operations);
        if (usage.failure) {
          throw usage.failure;
        }
        return [];
      },
    };

    return pipeline;
  },
};

let installed = false;

export async function installAuthMocks(): Promise<void> {
  if (installed) {
    return;
  }

  const [actualDrizzle, actualRedis] = await Promise.all([import('@repo/drizzle'), import('@repo/redis')]);

  mock.module('@repo/drizzle', () => ({
    ...actualDrizzle,
    db,
  }));
  mock.module('@repo/redis', () => ({
    ...actualRedis,
    consumeFixedWindowCounter,
    redis,
  }));

  installed = true;
}

export function resetDoubles(): void {
  database.reset();
  quota.reset();
  usage.reset();
  authCache.reset();
}

export { KEY_ID, ORGANIZATION_ID, USER_ID };

export function organizationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ORGANIZATION_ID,
    external_id: 'tenant-1',
    external_idp: 'https://issuer.example',
    name: 'Acme',
    slug: 'acme-tenant-1',
    status: 'active',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

export function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    username: 'alex',
    email: 'alex@example.test',
    name: 'Alex Example',
    status: 'active',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

export function apiKeyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: KEY_ID,
    organization_id: ORGANIZATION_ID,
    name: 'automation',
    description: null,
    key_hash: 'a'.repeat(64),
    creator_id: USER_ID,
    scopes: 'logs:read logs:write',
    rate_limit_requests: null,
    rate_limit_window: null,
    allowed_ips: null,
    expires_at: null,
    revoked_at: null,
    revoked_by: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}
