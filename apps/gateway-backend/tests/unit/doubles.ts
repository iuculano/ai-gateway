import { mock } from 'bun:test';
import type { apiKeys, logs, models, webhooks } from '@repo/drizzle/schemas';
import type { Caller } from '@repo/hono';

/**
 * The stand-ins the unit tier runs against.
 *
 * Not a .test.ts file on purpose - bun would collect it as a suite. Every test
 * file here calls installModuleMocks() before importing anything that reaches
 * postgres or redis for real.
 */

// --- database ----------------------------------------------------------------

/** One scripted answer to one database round trip. */
export type Step = { rows: unknown[] } | { error: Error };

/** A query that answers with these rows. Pass nothing for an empty result. */
export function rows(...values: unknown[]): Step {
  return { rows: values };
}

/** A query that rejects - the channel every unexpected failure travels down. */
export function failsWith(error: Error): Step {
  return { error };
}

export const database = {
  steps: [] as Step[],
  consumed: 0,

  /** One entry per transaction opened, in order, recording how it ended. */
  transactions: [] as { committed: boolean; rolledBack: boolean }[],

  /**
   * Every builder method the services called, with its arguments.
   *
   * What a query was ASKED to do, as opposed to what it was told in reply -
   * the only way to assert on the values a write actually carried.
   */
  calls: [] as { method: string; args: unknown[] }[],

  /**
   * The answers this test's queries get, in the order they are issued.
   *
   * A query beyond the end of the script rejects rather than returning nothing:
   * an unscripted call is the test being wrong, and an empty result would read
   * as a deliberate "no rows" and quietly pass.
   */
  script(...steps: Step[]) {
    database.steps = steps;
    database.consumed = 0;
    database.transactions = [];
    database.calls = [];
  },

  reset() {
    database.script();
  },
};

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

/**
 * A query builder that accepts any chain and resolves to the next scripted
 * answer.
 *
 * Every method returns the builder itself, so .select().from().where() and
 * .update().set().where().returning() both work without naming them.
 */
function queryBuilder(): unknown {
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          return (resolve: (value: unknown) => void, reject: (reason: unknown) => void) =>
            nextRows().then(resolve, reject);
        }

        // Symbols are the runtime asking questions (Symbol.toStringTag and
        // friends), not the service calling a query method.
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

// biome-ignore lint/suspicious/noExplicitAny: a stand-in for drizzle's builder, which is not worth reproducing in types
const scopedDb: any = {
  select: () => queryBuilder(),
  insert: () => queryBuilder(),
  update: () => queryBuilder(),
  delete: () => queryBuilder(),

  async transaction(callback: (tx: unknown) => Promise<unknown>) {
    const record = { committed: false, rolledBack: false };
    database.transactions.push(record);

    try {
      const value = await callback(scopedDb);
      record.committed = true;
      return value;
    } catch (error) {
      record.rolledBack = true;
      throw error;
    }
  },
};

// --- redis -------------------------------------------------------------------

export const cache = {
  /** Keyed by api key id: the usage hash as redis would hand it back. */
  usage: {} as Record<string, Record<string, string>>,

  /** Keyed by api key id: the fixed-window counter and its remaining ttl. */
  quota: {} as Record<string, { count: string | null; pttl: number }>,

  /** Set to make every command reject, which is what a redis outage looks like. */
  failure: null as Error | null,

  reset() {
    cache.usage = {};
    cache.quota = {};
    cache.failure = null;
  },
};

/** `api-keys:usage:<id>` and `api-keys:quota:<id>` both end in the id. */
function idFromKey(key: string): string {
  return key.split(':').at(-1) ?? '';
}

const redis = {
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
};

// --- audit logs --------------------------------------------------------------

export const audit = {
  // biome-ignore lint/suspicious/noExplicitAny: the audit body shape is the service's to know, not this file's
  calls: [] as { body: any; transactional: boolean }[],

  /** Set to make every write reject. */
  failure: null as Error | null,

  /**
   * Send writes to the real service instead of recording them.
   *
   * For audit-logs' own suite. mock.module replaces a module for the whole
   * process and cannot be undone by a later file, so which behaviour is wanted
   * has to be decided per test rather than per installation - bun loads the
   * test files in an order no single file controls.
   */
  passthrough: false,

  reset() {
    audit.calls = [];
    audit.failure = null;
    audit.passthrough = false;
  },
};

/**
 * Builds the audit stand-in around a copy of the real service.
 *
 * A shallow copy rather than a reference to the module: mock.module rebinds the
 * module's exports for everyone holding them, so reading
 * `actualModule.default.createAuditLog` at call time would find this file's own
 * stand-in and recurse until the stack gave out. Copying while the originals
 * are still the originals is what avoids that.
 */
function buildAuditLogServices(real: RealAuditLogServices) {
  return {
    // The reads stay real - only the write is worth standing in for, and a
    // suite testing this module needs the rest of it intact.
    ...real,

    async createAuditLog(context: Caller, body: unknown, executor?: unknown) {
      if (audit.passthrough) {
        // biome-ignore lint/suspicious/noExplicitAny: handing the real signature straight back through
        return real.createAuditLog(context, body as any, executor as any);
      }

      audit.calls.push({ body, transactional: executor !== undefined });

      if (audit.failure) {
        throw audit.failure;
      }

      return body;
    },
  };
}

type RealAuditLogServices = typeof import('../../src/api/audit-logs/audit-logs.services')['default'];

// --- object storage ----------------------------------------------------------

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

// --- installation ------------------------------------------------------------

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
 * The audit specifier is resolved relative to THIS file, not to the service
 * that imports it - so moving this file changes what gets mocked, silently and
 * with no error. That is why it is spelled out from tests/unit rather than as
 * the '../audit-logs/audit-logs.services' the service itself writes.
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
  // use, and the audit service only reaches for it when called.
  const actualDrizzle = await import('@repo/drizzle');
  const actualHono = await import('@repo/hono');
  const realAuditLogServices = { ...(await import('../../src/api/audit-logs/audit-logs.services')).default };
  const auditLogServices = buildAuditLogServices(realAuditLogServices);

  mock.module('@repo/drizzle', () => ({
    // Everything real by default - the condition builders included, since
    // nothing here inspects what they return. Only the four entry points that
    // would open a connection are replaced.
    ...actualDrizzle,

    db: scopedDb,
  }));

  // Read-only service tests historically did not need an ambient caller because
  // the database supplied the organization filter. They do now.
  // Preserve an explicitly bound caller when a test provides one and otherwise
  // use the standard fixture so those tests remain focused on their result
  // handling rather than AsyncLocalStorage setup.
  mock.module('@repo/hono', () => ({
    ...actualHono,
    getCaller: () => {
      try {
        return actualHono.getCaller();
      } catch {
        return callerFixture;
      }
    },
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

  // Same reasoning as redis: the real module builds an S3 client from the
  // environment on first use, and a unit test has no bucket.
  mock.module('@repo/object-storage', () => ({
    objectStorage,
    createObjectStorageFromEnvironment: notStubbed('createObjectStorageFromEnvironment'),
  }));

  mock.module('../../src/api/audit-logs/audit-logs.services', () => ({ default: auditLogServices }));
}

function notStubbed(name: string) {
  return () => {
    throw new Error(`${name} is not stubbed. Add it to doubles.ts if a test needs it.`);
  };
}

export function resetDoubles() {
  database.reset();
  cache.reset();
  audit.reset();
  objects.reset();
}

// --- fixtures ----------------------------------------------------------------

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

export const ORGANIZATION_ID = '01912d3f-9b4a-7c3d-8e2f-000000000001';
export const USER_ID = '01912d3f-9b4a-7c3d-8e2f-000000000002';
export const KEY_ID = '01912d3f-9b4a-7c3d-8e2f-000000000003';
export const WEBHOOK_ID = '01912d3f-9b4a-7c3d-8e2f-000000000005';
export const MODEL_ID = '01912d3f-9b4a-7c3d-8e2f-000000000006';
export const LOG_ID = '01912d3f-9b4a-7c3d-8e2f-000000000007';

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
    name: 'gpt-4-turbo',
    provider: 'openai',
    cost_input: '0.000010000000',
    cost_output: '0.000030000000',
    config: {},
    tags: {},
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
