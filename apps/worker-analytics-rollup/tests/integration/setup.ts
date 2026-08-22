import { SQL } from 'bun';

const connectionString = process.env.POSTGRES_TEST_ADMIN_CONNECTION_STRING;

if (!connectionString) {
  throw new Error(
    'POSTGRES_TEST_ADMIN_CONNECTION_STRING is unset. Start Postgres and run `bun run test:db:setup` first.',
  );
}

const databaseName = new URL(connectionString).pathname.replace(/^\//, '');
if (!databaseName.endsWith('_test')) {
  throw new Error(`Refusing to truncate "${databaseName}": an integration database must end in "_test".`);
}

process.env.NODE_ENV = 'test';
process.env.POSTGRES_CONNECTION_STRING = connectionString;

export const admin = new SQL(connectionString);

export async function prepareSuite(): Promise<void> {
  const { db } = await import('@repo/drizzle');
  await db.execute('SELECT 1');
}

export async function resetDatabase(): Promise<void> {
  await admin.unsafe('truncate table analytics_hourly, logs, users, organizations restart identity cascade');
}
