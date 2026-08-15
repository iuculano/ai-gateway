import type { Caller } from '@repo/hono';
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
      `${name} is unset, so the integration tier has no database to run against.\n\n` +
        '  docker compose up -d postgres valkey\n' +
        '  bun run test:db:setup\n\n' +
        'Both connection strings are in apps/backend/.env.example. This fails rather than ' +
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

const applicationConnectionString = required('POSTGRES_TEST_CONNECTION_STRING');
const adminConnectionString = required('POSTGRES_TEST_ADMIN_CONNECTION_STRING');

assertIsTestDatabase(applicationConnectionString);
assertIsTestDatabase(adminConnectionString);

// Must happen before the first query, not before the first import - see the
// module comment. Set unconditionally: a stale value from a developer's .env
// would otherwise point the whole suite at the development database.
process.env.POSTGRES_CONNECTION_STRING = applicationConnectionString;

/**
 * The privileged connection, used only by the harness.
 *
 * Test assertions read through this rather than through the application's
 * client, so "the row is really there" is answered by something that does not
 * share the code under test's opinion about what it can see. Truncation needs
 * it too - app_user has DML grants and no TRUNCATE.
 */
export const admin = new SQL(adminConnectionString);

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
  // Nothing mocks redis here, and importing @repo/redis no longer connects -
  // so the suite opens the connection the way the app's boot does. Services
  // that hydrate usage counts reach it for real.
  const { connectRedis } = await import('@repo/redis');
  await connectRedis();
}

export async function resetDatabase(): Promise<void> {
  await admin.unsafe(`truncate table ${TABLES.join(', ')} restart identity cascade`);
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
