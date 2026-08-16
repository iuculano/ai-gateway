import { mock } from 'bun:test';

export type DatabaseStep = { rows: unknown[] } | { error: Error };

export const database = {
  steps: [] as DatabaseStep[],
  consumed: 0,
  calls: [] as { method: string; args: unknown[] }[],
  transactions: [] as { committed: boolean; rolledBack: boolean }[],

  script(...steps: DatabaseStep[]) {
    database.steps = steps;
    database.consumed = 0;
    database.calls = [];
    database.transactions = [];
  },
};

export function rows(...values: unknown[]): DatabaseStep {
  return { rows: values };
}

export function failsWith(error: Error): DatabaseStep {
  return { error };
}

function nextRows(): Promise<unknown[]> {
  const step = database.steps[database.consumed++];
  if (!step) {
    return Promise.reject(new Error(`Unscripted database call (query ${database.consumed})`));
  }

  if ('error' in step) {
    return Promise.reject(step.error);
  }

  return Promise.resolve(step.rows);
}

function queryBuilder(): unknown {
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          return (resolve: (value: unknown) => void, reject: (reason: unknown) => void) =>
            nextRows().then(resolve, reject);
        }

        if (typeof property === 'symbol') {
          return undefined;
        }

        return (...args: unknown[]) => {
          database.calls.push({ method: property, args });
          return builder;
        };
      },
    },
  );

  return builder;
}

function startQuery(method: string, args: unknown[]): unknown {
  database.calls.push({ method, args });
  return queryBuilder();
}

// biome-ignore lint/suspicious/noExplicitAny: reproducing Drizzle's fluent builder types adds no test value
const db: any = {
  select: (...args: unknown[]) => startQuery('select', args),
  insert: (...args: unknown[]) => startQuery('insert', args),
  update: (...args: unknown[]) => startQuery('update', args),
  delete: (...args: unknown[]) => startQuery('delete', args),

  async transaction(callback: (tx: unknown) => Promise<unknown>) {
    const transaction = { committed: false, rolledBack: false };
    database.transactions.push(transaction);

    try {
      const result = await callback(db);
      transaction.committed = true;
      return result;
    } catch (error) {
      transaction.rolledBack = true;
      throw error;
    }
  },
};

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

const redis = {
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
  database.script();
  quota.reset();
  usage.reset();
}

export const ORGANIZATION_ID = '01912d3f-9b4a-7c3d-8e2f-000000000001';
export const USER_ID = '01912d3f-9b4a-7c3d-8e2f-000000000002';
export const KEY_ID = '01912d3f-9b4a-7c3d-8e2f-000000000003';

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
