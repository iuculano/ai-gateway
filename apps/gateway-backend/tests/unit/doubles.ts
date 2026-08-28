import { afterEach, mock } from 'bun:test';
import type { apiKeys, logs, models, webhooks } from '@repo/drizzle/schemas';
import type { Caller } from '@repo/hono';
import {
  createDatabaseDouble,
  type DatabaseQuery,
  type DatabaseResponse,
  failsWith,
  KEY_ID,
  ORGANIZATION_ID,
  rows,
  USER_ID,
} from '@repo/test-helpers';

/**
 * The stand-ins the unit tier runs against.
 *
 * Not a .test.ts file on purpose - bun would collect it as a suite. Every test
 * file here calls installModuleMocks() before importing anything that reaches
 * postgres or redis for real.
 */

// Database

export { failsWith, rows };

const { database, db: scopedDb } = createDatabaseDouble();

export { database };

afterEach(() => {
  database.assertResponsesConsumed();
});

let runWithRealCaller: typeof import('@repo/hono').runWithCaller | undefined;

/**
 * Binds a public service object to the real request context implementation.
 *
 * Service tests can stay terse without replacing our own `@repo/hono` module.
 * Every method still executes through AsyncLocalStorage exactly as it does from
 * a handler, while only the process boundaries below are faked.
 */
export function forCaller<T extends object>(services: T, caller: Caller = callerFixture): T {
  const run = runWithRealCaller;
  if (!run) {
    throw new Error('installModuleMocks() must run before binding caller-scoped services');
  }

  return new Proxy(services, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') {
        return value;
      }

      return (...args: unknown[]) => run(caller, () => Reflect.apply(value, target, args));
    },
  });
}

// Redis

export const cache = {
  /** Keyed by api key id: the usage hash as redis would hand it back. */
  usage: {} as Record<string, Record<string, string>>,

  /** Keyed by api key id: the fixed-window counter and its remaining ttl. */
  quota: {} as Record<string, { count: string | null; pttl: number }>,

  /** Set to make every command reject, which is what a redis outage looks like. */
  failure: null as Error | null,

  /** Redis keys deleted by the service, in call order. */
  deleted: [] as string[],

  reset() {
    cache.usage = {};
    cache.quota = {};
    cache.failure = null;
    cache.deleted = [];
  },
};

/** The Redis EVAL boundary used by the real fixed-window rate limiter. */
export const fixedWindow = {
  result: [1, 1, 60_000] as [count: number, remaining: number, pttl: number],
  calls: [] as { keys: string[]; arguments: string[] }[],

  reset() {
    fixedWindow.result = [1, 1, 60_000];
    fixedWindow.calls = [];
  },
};

/** `api-keys:usage:<id>` and `api-keys:quota:<id>` both end in the id. */
function idFromKey(key: string): string {
  return key.split(':').at(-1) ?? '';
}

const redis = {
  async eval(_script: string, options: { keys: string[]; arguments: string[] }) {
    if (cache.failure) {
      throw cache.failure;
    }

    fixedWindow.calls.push(options);
    return fixedWindow.result;
  },

  multi() {
    const keys: string[] = [];

    const pipeline = {
      hGetAll(key: string) {
        keys.push(key);
        return pipeline;
      },
      get(key: string) {
        keys.push(key);
        return pipeline;
      },
      pTTL(key: string) {
        keys.push(key);
        return pipeline;
      },
      async execTyped() {
        // A failed command rejects the whole exec, so there is no partial
        // result for the service to misread.
        if (cache.failure) {
          throw cache.failure;
        }

        const id = idFromKey(keys[0] ?? '');

        // pTTL answers -2 for a key that is not there at all.
        return [cache.usage[id] ?? {}, cache.quota[id]?.count ?? null, cache.quota[id]?.pttl ?? -2];
      },
    };

    return pipeline;
  },

  async hGet(key: string, field: string) {
    if (cache.failure) {
      throw cache.failure;
    }

    return cache.usage[idFromKey(key)]?.[field] ?? null;
  },

  async del(key: string) {
    if (cache.failure) {
      throw cache.failure;
    }

    cache.deleted.push(key);
    delete cache.quota[idFromKey(key)];
    return 1;
  },
};

// Owned services observed at their database boundary

function queryCall(query: DatabaseQuery, method: string): unknown[] | undefined {
  return query.calls.find((call) => call.method === method)?.args;
}

function writesTo(table: string, operation: 'insert' | 'update'): DatabaseQuery[] {
  return database.queriesFor(operation, table);
}

/**
 * Observations of the REAL audit service's inserts.
 *
 * This intentionally resembles the old capture API so assertions stay terse,
 * but nothing here replaces an owned module. `createAuditLog` runs normally;
 * these values come from the Drizzle boundary it reached.
 */
export const auditWrites = {
  get calls(): { body: Record<string, unknown>; transactional: boolean }[] {
    return writesTo('audit_logs', 'insert').map((query) => ({
      body: (queryCall(query, 'values')?.[0] ?? {}) as Record<string, unknown>,
      transactional: query.transaction !== null,
    }));
  },

  failNext(error: Error) {
    database.respondTo('insert', 'audit_logs', failsWith(error));
  },
};

function persistedAuditRow(query: DatabaseQuery): DatabaseResponse {
  const values = (queryCall(query, 'values')?.[0] ?? {}) as Record<string, unknown>;
  return rows({
    id: AUDIT_ID,
    ...values,
    actor_id: values.actor_id ?? null,
    target_type: values.target_type ?? null,
    target_id: values.target_id ?? null,
    difference: values.difference ?? null,
    metadata: values.metadata ?? null,
    request_id: values.request_id ?? null,
    ip: values.ip ?? null,
    user_agent: values.user_agent ?? null,
    occurred_at: values.occurred_at ?? new Date('2026-01-01T00:00:00.000Z'),
    created_at: new Date('2026-01-01T00:00:00.000Z'),
  });
}

/**
 * Observations of the REAL log lifecycle service's database writes.
 *
 * The chat suite installs the defaults explicitly. Other log-service tests are
 * free to configure their own insert/update outcomes.
 */
export const logWrites = {
  installDefaults() {
    database.defaultResponse('insert', 'logs', rows({ id: LOG_ID }));
    database.defaultResponse('update', 'logs', rows());
  },

  failNextStart(error: Error) {
    database.respondTo('insert', 'logs', failsWith(error));
  },

  failNextFinish(error: Error) {
    database.respondTo('update', 'logs', failsWith(error));
  },

  get started(): { organizationId: string; entry: Record<string, unknown> }[] {
    return writesTo('logs', 'insert').map((query) => {
      const values = { ...((queryCall(query, 'values')?.[0] ?? {}) as Record<string, unknown>) };
      const organizationId = String(values.organization_id);
      delete values.organization_id;
      delete values.status;
      return { organizationId, entry: values };
    });
  },

  get completed(): { organizationId: string; id: string; entry: Record<string, unknown> }[] {
    return writesTo('logs', 'update').flatMap((query) => {
      const values = { ...((queryCall(query, 'set')?.[0] ?? {}) as Record<string, unknown>) };
      if (values.status !== 'complete') {
        return [];
      }

      const requestReference = values.request_object_reference;
      const responseReference = values.response_object_reference;
      if (typeof requestReference === 'string') {
        values.request = objects.stored[requestReference];
      }
      if (typeof responseReference === 'string') {
        values.response = objects.stored[responseReference];
      }

      return [{ organizationId: ORGANIZATION_ID, id: LOG_ID, entry: values }];
    });
  },

  get failed(): { organizationId: string; id: string; entry: Record<string, unknown> }[] {
    return writesTo('logs', 'update').flatMap((query) => {
      const values = { ...((queryCall(query, 'set')?.[0] ?? {}) as Record<string, unknown>) };
      if (values.status !== 'failed') {
        return [];
      }

      const requestReference = values.request_object_reference;
      if (typeof requestReference === 'string') {
        values.request = objects.stored[requestReference];
      }

      return [{ organizationId: ORGANIZATION_ID, id: LOG_ID, entry: values }];
    });
  },
};

// Object storage

export const objects = {
  /** Stored payloads, keyed by object key. An absent key reads back as null. */
  stored: {} as Record<string, unknown>,

  /** Keys handed to deleteMany, in call order. */
  deleted: [] as string[][],

  /** Set to make every read and write reject - a bucket that is unreachable. */
  failure: null as Error | null,

  reset() {
    objects.stored = {};
    objects.deleted = [];
    objects.failure = null;
  },
};

const objectStorage = {
  async getJson(key: string) {
    if (objects.failure) {
      throw objects.failure;
    }

    // null rather than undefined: the real store distinguishes "no such object"
    // from a stored null, and the services branch on exactly that.
    return key in objects.stored ? objects.stored[key] : null;
  },

  async getManyJson(keys: string[]) {
    if (objects.failure) {
      throw objects.failure;
    }

    const found = new Map<string, unknown>();
    for (const key of keys) {
      if (key in objects.stored) {
        found.set(key, objects.stored[key]);
      }
    }

    return found;
  },

  async putJson(key: string, value: unknown) {
    if (objects.failure) {
      throw objects.failure;
    }

    objects.stored[key] = value;
  },

  async delete(key: string) {
    delete objects.stored[key];
  },

  async deleteMany(keys: string[]) {
    if (objects.failure) {
      throw objects.failure;
    }

    objects.deleted.push(keys);
    for (const key of keys) {
      delete objects.stored[key];
    }
  },
};

// Installation

/**
 * Replaces the modules that talk to something outside this process.
 *
 * Async, and the real modules are loaded inside it rather than at module
 * scope. Top-level await here used to leave `installModuleMocks` reading a
 * const that had not been initialised yet under `bun test --isolate`, where a
 * fresh registry per file changes when this module finishes evaluating. Doing
 * the work inside the call has no such ordering to get wrong.
 *
 * Must run before the module under test is imported, which is why the test
 * files import their subject with a dynamic import after awaiting this.
 *
 * Application services stay real. Only process boundaries are replaced here,
 * so refactoring a service import cannot silently bypass the behavior a test
 * means to exercise.
 */
export async function installModuleMocks() {
  // Imported for real so the mocks below can be partial ones. mock.module()
  // replaces a module for every importer in the process, not just for the test
  // that asked - so a hand-written export list silently breaks any other module
  // that imports a name this file did not think of. That is not hypothetical:
  // it broke guardrails.services, which imports inArray, as soon as bun
  // happened to load it after this ran.
  //
  // Safe to import: drizzle's client is a lazy Proxy that connects on first
  // use.
  const actualDrizzle = await import('@repo/drizzle');
  const actualHono = await import('@repo/hono');
  runWithRealCaller = actualHono.runWithCaller;
  mock.module('@repo/drizzle', () => ({
    // Everything real by default - the condition builders included, since
    // nothing here inspects what they return. Only the client object that
    // would open a connection is replaced.
    ...actualDrizzle,

    db: scopedDb,
  }));

  // Spread like drizzle now that importing @repo/redis no longer connects.
  // The rate limiters come through real - they only reach the network when
  // called - so a module importing one this file did not think of keeps
  // working, rather than failing with a missing-export SyntaxError. That is the
  // bug that broke guardrails.services on `inArray`.
  //
  // connectRedis is replaced with a no-op: the stand-in below has no socket to
  // open, and anything calling it should not be waiting on one.
  const actualRedis = await import('@repo/redis');

  mock.module('@repo/redis', () => ({
    ...actualRedis,
    redis,
    connectRedis: async () => {},
  }));

  // The server initializes the real store on startup. Unit tests use the
  // in-memory stand-in above instead.
  mock.module('@repo/object-storage', () => ({
    objectStorage,
    createObjectStorage: notStubbed('createObjectStorage'),
  }));
}

function notStubbed(name: string) {
  return () => {
    throw new Error(`${name} is not stubbed. Add it to doubles.ts if a test needs it.`);
  };
}

export function resetDoubles() {
  database.reset();
  database.defaultResponse('insert', 'audit_logs', persistedAuditRow);
  cache.reset();
  fixedWindow.reset();
  objects.reset();

  // The caller is a shared mutable object and suites reassign its scopes to
  // exercise refusals. Without restoring it, a grant made by one file is still
  // in force in the next one - which under --isolate never showed, and without
  // it made an api-keys assertion fail because a prompts suite had run first.
  callerFixture.permissions = { scopes: [...BASE_CALLER_SCOPES] };
}

// Fixtures

/**
 * Overrides for a row fixture: the table's own column names, any value.
 *
 * The keys are constrained and the values are not, deliberately. A typo -
 * `revokedAt` for `revoked_at` - would otherwise be accepted in silence and the
 * test would pass having asserted nothing. The values stay loose because these
 * fixtures are shaped like what the DRIVER returns rather than what
 * $inferSelect claims: `numeric` columns arrive as strings, which is the whole
 * point of the coercion the response schemas do.
 */
type RowOverrides<TRow> = Partial<Record<keyof TRow, unknown>>;

export { KEY_ID, ORGANIZATION_ID, USER_ID };

export const WEBHOOK_ID = '01912d3f-9b4a-7c3d-8e2f-000000000005';
export const MODEL_ID = '01912d3f-9b4a-7c3d-8e2f-000000000006';
export const LOG_ID = '01912d3f-9b4a-7c3d-8e2f-000000000007';
export const AUDIT_ID = '01912d3f-9b4a-7c3d-8e2f-00000000000a';

/** A stored row, as a select would hand it back. */
export function apiKeyRow(overrides: RowOverrides<typeof apiKeys.$inferSelect> = {}) {
  return {
    id: KEY_ID,
    organization_id: ORGANIZATION_ID,
    name: 'ci',
    description: null,
    key_hash: 'a'.repeat(64),
    creator_id: USER_ID,
    scopes: 'api-keys:read',
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

/** A stored webhook row, as a select would hand it back. */
export function webhookRow(overrides: RowOverrides<typeof webhooks.$inferSelect> = {}) {
  return {
    id: WEBHOOK_ID,
    organization_id: ORGANIZATION_ID,
    name: 'deploys',
    description: null,
    endpoint: 'https://example.test/hook',
    filter: null,
    tags: null,
    creator_id: USER_ID,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/**
 * A stored model row.
 *
 * The costs are strings on purpose: they are `numeric` columns, which come back
 * from the driver as strings rather than numbers. The response shape coerces
 * them, and this fixture is what keeps that honest.
 */
export function modelRow(overrides: RowOverrides<typeof models.$inferSelect> = {}) {
  return {
    id: MODEL_ID,
    source: 'builtin',
    name: 'gpt-4-turbo',
    provider: 'openai',
    display_name: 'GPT-4 Turbo',
    status: 'available',
    cost_input: '0.000010000000',
    cost_output: '0.000030000000',
    cost_cache_read: null,
    context_limit: 128000,
    attachment: false,
    reasoning: false,
    tool_call: true,
    structured_output: false,
    config: {},
    tags: {},
    organization_id: null,
    delisted_at: null,
    synced_at: new Date('2026-01-01T00:00:00.000Z'),
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/**
 * A stored log row.
 *
 * The costs are strings for the same reason as the model fixture: `numeric`
 * comes back from the driver as a string, and the response shape coerces it.
 */
export function logRow(overrides: RowOverrides<typeof logs.$inferSelect> = {}) {
  return {
    id: LOG_ID,
    organization_id: ORGANIZATION_ID,
    model: 'gpt-4-turbo',
    provider: 'openai',
    status: 'complete',
    // Matches callerFixture, so a completion driven by that caller and a row
    // read back through this fixture describe the same actor.
    actor_type: 'user',
    actor_id: USER_ID,
    input_tokens: 100,
    output_tokens: 50,
    input_cost: '0.001000000000',
    output_cost: '0.002000000000',
    response_time_ms: 1200,
    request_object_reference: null,
    response_object_reference: null,
    tags: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** A caller holding both api-key scopes. */
export const callerFixture: Caller = {
  organization: { id: ORGANIZATION_ID, name: 'acme' },
  actor: {
    type: 'user',
    user: { id: USER_ID, username: 'alex', email: 'alex@example.test' },
  },
  permissions: { scopes: ['api-keys:read', 'api-keys:write'] },
  request: {},
};

/** The scopes resetDoubles() puts back, captured before any suite widens them. */
const BASE_CALLER_SCOPES: readonly string[] = Object.freeze([...callerFixture.permissions.scopes]);
