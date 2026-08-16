import type { Caller } from '@repo/hono';
import type { CompressedJsonStore } from '@repo/object-storage';
import { SQL } from 'bun';

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
        '  docker compose up -d postgres valkey minio minio-init\n' +
        '  bun run test:db:setup\n\n' +
        'The local test values are in apps/gateway-backend/.env.example. This fails rather than ' +
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
  await Promise.all([db.execute('SELECT 1'), connectRedis()]);
}

export async function resetDatabase(): Promise<void> {
  const objectReferences = await admin`
    select request_object_reference, response_object_reference
    from logs
    where request_object_reference is not null or response_object_reference is not null
  `;
  const keys = objectReferences.flatMap(
    (row: { request_object_reference?: unknown; response_object_reference?: unknown }) =>
      [row.request_object_reference, row.response_object_reference].filter(
        (key): key is string => typeof key === 'string',
      ),
  );

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
    insert into users (username, email)
    values (${`${label}-user`}, ${`${label}@example.test`})
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
