import { mock } from 'bun:test';
import type { apiKeys, logs, models, webhooks } from '@repo/drizzle/schemas';
import type { Caller } from '@repo/hono';
import { createDatabaseDouble, failsWith, KEY_ID, ORGANIZATION_ID, rows, type Step, USER_ID } from '@repo/test-helpers';

/**
 * The stand-ins the unit tier runs against.
 *
 * Not a .test.ts file on purpose - bun would collect it as a suite. Every test
 * file here calls installModuleMocks() before importing anything that reaches
 * postgres or redis for real.
 */

// --- database ----------------------------------------------------------------

export type { Step };

export { failsWith, rows };

const { database, db: scopedDb } = createDatabaseDouble();

export { database };

// --- redis -------------------------------------------------------------------

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

  async del(key: string) {
    if (cache.failure) {
      throw cache.failure;
    }

    cache.deleted.push(key);
    delete cache.quota[idFromKey(key)];
    return 1;
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

    async createAuditLog(body: unknown, executor?: unknown) {
      if (audit.passthrough) {
        // biome-ignore lint/suspicious/noExplicitAny: handing the real signature straight back through
        return real.createAuditLog(body as any, executor as any);
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

// --- log lifecycle -----------------------------------------------------------

/**
 * The inference path's writes to logs.services, captured instead of performed.
 *
 * Passthrough by default, unlike `audit`. Most suites - logs.test.ts above all -
 * want the real functions, and only the chat-completions suite wants to watch
 * them without running them. Standing them in unconditionally is what forced
 * this package onto --isolate: mock.module is process-wide, so one suite's
 * three-function stand-in became every suite's entire logs module.
 */
export const logCapture = {
  started: [] as { organizationId: string; entry: unknown }[],
  completed: [] as { organizationId: string; id: string; entry: Record<string, unknown> }[],
  failed: [] as { organizationId: string; id: string; entry: Record<string, unknown> }[],

  /** True runs the real implementation; false records the call and returns. */
  passthrough: true,

  reset() {
    logCapture.started = [];
    logCapture.completed = [];
    logCapture.failed = [];
    logCapture.passthrough = true;
  },
};

type RealLogServices = typeof import('../../src/api/logs/logs.services')['default'];

/** Same copy-then-wrap shape as buildAuditLogServices, for the same reason. */
function buildLogServices(real: RealLogServices) {
  return {
    ...real,

    async startLog(organizationId: string, entry: never) {
      if (logCapture.passthrough) {
        return real.startLog(organizationId, entry);
      }

      logCapture.started.push({ organizationId, entry });

      // Read here rather than in the object literal above: LOG_ID is declared
      // further down this file, so an initializer would hit the temporal dead
      // zone. A function body is evaluated at call time and does not.
      return LOG_ID;
    },

    async completeLog(organizationId: string, id: string, entry: never) {
      if (logCapture.passthrough) {
        return real.completeLog(organizationId, id, entry);
      }

      logCapture.completed.push({ organizationId, id, entry });
    },

    async failLog(organizationId: string, id: string, entry: never) {
      if (logCapture.passthrough) {
        return real.failLog(organizationId, id, entry);
      }

      logCapture.failed.push({ organizationId, id, entry });
    },
  };
}

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
  const realLogServices = { ...(await import('../../src/api/logs/logs.services')).default };
  const logServices = buildLogServices(realLogServices);

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

  // The server initializes the real store on startup. Unit tests use the
  // in-memory stand-in above instead.
  mock.module('@repo/object-storage', () => ({
    objectStorage,
    createObjectStorage: notStubbed('createObjectStorage'),
  }));

  mock.module('../../src/api/audit-logs/audit-logs.services', () => ({ default: auditLogServices }));
  mock.module('../../src/api/logs/logs.services', () => ({ default: logServices }));
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
  logCapture.reset();

  // The caller is a shared mutable object and suites reassign its scopes to
  // exercise refusals. Without restoring it, a grant made by one file is still
  // in force in the next one - which under --isolate never showed, and without
  // it made an api-keys assertion fail because a prompts suite had run first.
  callerFixture.permissions = { scopes: [...BASE_CALLER_SCOPES] };
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

export { KEY_ID, ORGANIZATION_ID, USER_ID };

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
