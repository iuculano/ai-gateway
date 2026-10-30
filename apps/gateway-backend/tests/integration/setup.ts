import { generateActorId } from '@repo/core';
import type { Caller } from '@repo/hono';
import type { CompressedJsonStore } from '@repo/object-storage';
import { SQL } from 'bun';
import { payloadKey } from '../../src/api/logs/logs.writer';

/**
 * The integration tier's connection to a real postgres.
 *
 * Loaded through `bun test --preload`, not by import order. It rewrites
 * POSTGRES_CONNECTION_STRING, which has to happen before anything reaches for
 * the shared client - and an import at the top of each test file would look
 * like it guaranteed that while actually depending on two things: that biome's
 * import sorter leaves it first (it does not), and that @repo/drizzle builds
 * its client lazily. Preloading owes nothing to either.
 *
 * Nothing here is mocked. That is the entire point: the tests above this
 * directory prove that the services classify failures correctly, and these
 * prove that the SQL those services emit does what it says against a real
 * database, including the application-level organization predicates.
 */

function required(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `${name} is unset, so the integration tier cannot initialize its external services.\n\n` +
        'Run `bun run test:integration` from the repository root to start the local services, ' +
        'supply safe test defaults, and prepare the database.\n\n' +
        'This fails rather than ' +
        'skipping on purpose: a suite that turns green when its infrastructure is missing ' +
        'is worse than one that fails.',
    );
  }

  return value;
}

/**
 * Refuses to run against a database whose name does not end in `_test`.
 *
 * resetDatabase() truncates every table it knows about. Pointed at
 * `ai_gateway`, that is somebody's afternoon; pointed at a production URL it is
 * considerably worse. The suffix is cheap to require and makes the mistake
 * impossible rather than unlikely.
 */
function assertIsTestDatabase(connectionString: string): void {
  const name = new URL(connectionString).pathname.replace(/^\//, '');

  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to run: the integration tier truncates every table, and "${name}" is not a test ` +
        'database. Its name must end in "_test". See test:db:setup.',
    );
  }
}

/** Refuses to flush Redis' default database, which development also uses. */
function assertIsTestRedis(connectionString: string): void {
  const database = Number(new URL(connectionString).pathname.replace(/^\//, '') || '0');

  if (!Number.isInteger(database) || database <= 0) {
    throw new Error(
      'Refusing to run: REDIS_TEST_URL must select a numbered database above 0, because the ' +
        'integration tier flushes it between tests.',
    );
  }
}

const adminConnectionString = required('POSTGRES_TEST_ADMIN_CONNECTION_STRING');
const redisConnectionString = required('REDIS_TEST_URL');
const victoriaTracesUrl = required('VICTORIA_TRACES_TEST_URL');
const objectStorageOptions = {
  endpoint: required('S3_TEST_ENDPOINT'),
  bucket: required('S3_TEST_BUCKET'),
  accessKeyId: required('S3_TEST_ACCESS_KEY_ID'),
  secretAccessKey: required('S3_TEST_SECRET_ACCESS_KEY'),
  region: process.env.S3_TEST_REGION ?? 'us-east-1',
};

assertIsTestDatabase(adminConnectionString);
assertIsTestRedis(redisConnectionString);

// Must happen before the first query, not before the first import - see the
// module comment. Set unconditionally: a stale value from a developer's .env
// would otherwise point the whole suite at the development database.
process.env.POSTGRES_CONNECTION_STRING = adminConnectionString;
process.env.REDIS_URL = redisConnectionString;
process.env.VICTORIA_TRACES_URL = victoriaTracesUrl;
const clickhouseUrl = required('CLICKHOUSE_TEST_URL');
process.env.CLICKHOUSE_URL = clickhouseUrl;
process.env.CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_TEST_PASSWORD ?? '';
process.env.CLICKHOUSE_DATABASE = 'ai_gateway_test';
process.env.S3_ENDPOINT = objectStorageOptions.endpoint;
process.env.S3_BUCKET = objectStorageOptions.bucket;
process.env.S3_ACCESS_KEY_ID = objectStorageOptions.accessKeyId;
process.env.S3_SECRET_ACCESS_KEY = objectStorageOptions.secretAccessKey;
process.env.S3_REGION = objectStorageOptions.region;
process.env.AUTH_TOKEN_ISSUER = 'https://issuer.integration.test';
process.env.AUTH_TOKEN_AUDIENCE = 'gateway-integration-tests';
process.env.NODE_ENV = 'test';

/**
 * The harness's direct database connection.
 *
 * Test assertions and fixture setup use this independently from the shared
 * Drizzle client used by the services under test. There is deliberately no
 * separate application role: tenant isolation is implemented and tested in the
 * services' explicit organization predicates, not through database RLS.
 */
export const admin = new SQL(adminConnectionString);

let integrationObjectStorage: CompressedJsonStore | undefined;
let flushIntegrationRedis: (() => Promise<unknown>) | undefined;

/** Tables the harness owns, in an order that satisfies the foreign keys. */
const TABLES = [
  'audit_logs',
  'api_keys',
  'guardrails',
  'trace_spans',
  'traces',
  'logs',
  'webhooks',
  'models',
  'user_identities',
  'users',
  'organizations',
] as const;

/**
 * Opens the external services used by the integration tests.
 */
export async function prepareSuite(): Promise<void> {
  // Nothing is mocked here, so initialize all external clients before a test
  // enters runWithCaller(). Bun's SQL driver may otherwise establish its first
  // connection from inside AsyncLocalStorage and lose that ambient scope while
  // opening the socket, making only the first service call fail spuriously.
  const [{ db }, { connectRedis, redis }, { createObjectStorage }] = await Promise.all([
    import('@repo/drizzle'),
    import('@repo/redis'),
    import('@repo/object-storage'),
  ]);

  integrationObjectStorage ??= createObjectStorage(objectStorageOptions);
  flushIntegrationRedis ??= () => redis.flushDb();
  await Promise.all([db.execute('SELECT 1'), connectRedis(), prepareClickHouse()]);
}

/**
 * Copies every Postgres log into ClickHouse, as the analytics worker's sync
 * would, for tests that seed Postgres and then read analytics.
 */
export async function syncLogsToClickHouse(): Promise<void> {
  const { clickhouse } = await import('@repo/clickhouse');
  const rows = await admin`
    select
      id, organization_id,
      to_char(created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') as created_at,
      to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') as updated_at,
      operation, model, provider, status, actor_id,
      input_tokens, output_tokens,
      input_cost, output_cost, response_time_ms
    from logs
  `;
  await clickhouse.insert({ table: 'logs', values: rows, format: 'JSONEachRow' });
}

/** The analytics tables, in a database of their own. */
async function prepareClickHouse(): Promise<void> {
  const { clickhouse, createClickHouse, ensureSchema } = await import('@repo/clickhouse');
  await createClickHouse({ database: 'default' }).command({
    query: 'CREATE DATABASE IF NOT EXISTS ai_gateway_test',
  });
  await ensureSchema(clickhouse);
}

export async function resetDatabase(): Promise<void> {
  const stored = await admin`select organization_id, id from logs where has_request or has_response`;
  const keys = stored.map((row: { organization_id: string; id: string }) => payloadKey(row.organization_id, row.id));

  if (keys.length > 0) {
    if (!integrationObjectStorage) {
      throw new Error('prepareSuite() must initialize object storage before resetDatabase() cleans payloads');
    }

    await integrationObjectStorage.deleteMany(keys);
  }

  if (!flushIntegrationRedis) {
    throw new Error('prepareSuite() must initialize Redis before resetDatabase() cleans test state');
  }

  await Promise.all([
    admin.unsafe(`truncate table ${TABLES.join(', ')} restart identity cascade`),
    flushIntegrationRedis(),
    import('@repo/clickhouse').then(({ clickhouse }) =>
      // The query cache isn't cleared by a truncate; drop it too, or a test
      // can get the previous test's numbers.
      clickhouse
        .command({ query: 'TRUNCATE TABLE IF EXISTS logs SYNC' })
        .then(() => clickhouse.command({ query: 'SYSTEM DROP QUERY CACHE' })),
    ),
  ]);
}

export interface Tenant {
  label: string;
  organizationId: string;
  userId: string;
}

export function callerFor(tenant: Tenant, scopes: string[] = []): Caller {
  return {
    organization: { id: tenant.organizationId, name: tenant.label },
    actor: {
      type: 'user',
      user: {
        id: tenant.userId,
        username: `${tenant.label}-user`,
        email: `${tenant.label}@example.test`,
      },
    },
    permissions: { scopes },
    request: {},
  };
}

/**
 * An organization and a user who belongs to it.
 *
 * Written with the admin connection because seeding is not the thing under
 * test. `slug` and `external_id` carry the
 * label so a leaked row is traceable to the test that made it.
 */
export async function seedTenant(label: string): Promise<Tenant> {
  const [organization] = await admin`
    insert into organizations (external_id, external_idp, name, slug)
    values (${`ext-${label}`}, 'test-idp', ${label}, ${label})
    returning id
  `;

  const [user] = await admin`
    insert into users (id, username, email)
    values (${generateActorId('user')}, ${`${label}-user`}, ${`${label}@example.test`})
    returning id
  `;

  if (!organization || !user) {
    throw new Error(`Failed to seed tenant "${label}"`);
  }

  await admin`
    insert into user_identities (user_id, external_idp, external_id)
    values (${user.id}, 'test-idp', ${`ext-${label}-user`})
  `;

  return { label, organizationId: organization.id, userId: user.id };
}

/** Rows the application wrote, read back through the privileged connection. */
export async function readApiKeyRow(id: string) {
  const [row] = await admin`select * from api_keys where id = ${id}`;

  return row;
}

export async function readAuditRows(targetId: string) {
  return admin`select * from audit_logs where target_id = ${targetId} order by occurred_at`;
}
