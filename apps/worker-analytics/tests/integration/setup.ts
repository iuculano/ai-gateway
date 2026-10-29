import { SQL } from 'bun';

const connectionString = process.env.POSTGRES_TEST_ADMIN_CONNECTION_STRING;
const clickhouseUrl = process.env.CLICKHOUSE_TEST_URL;

if (!connectionString || !clickhouseUrl) {
  throw new Error(
    'POSTGRES_TEST_ADMIN_CONNECTION_STRING and CLICKHOUSE_TEST_URL must be set. Run scripts/test-integration.ts.',
  );
}

const databaseName = new URL(connectionString).pathname.replace(/^\//, '');
if (!databaseName.endsWith('_test')) {
  throw new Error(`Refusing to truncate "${databaseName}": an integration database must end in "_test".`);
}

process.env.NODE_ENV = 'test';
process.env.POSTGRES_CONNECTION_STRING = connectionString;
process.env.CLICKHOUSE_URL = clickhouseUrl;
process.env.CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_TEST_PASSWORD ?? '';
process.env.CLICKHOUSE_DATABASE = 'ai_gateway_test';
// Small batches, so a handful of rows crosses several of them.
process.env.SYNC_BATCH_ROWS = '2';

export const admin = new SQL(connectionString);

export async function prepareSuite(): Promise<void> {
  const { db } = await import('@repo/drizzle');
  await db.execute('SELECT 1');
  const { clickhouse, createClickHouse, ensureSchema } = await import('@repo/clickhouse');
  await createClickHouse({ database: 'default' }).command({
    query: 'CREATE DATABASE IF NOT EXISTS ai_gateway_test',
  });
  await ensureSchema(clickhouse);
}

export async function resetDatabase(): Promise<void> {
  await admin.unsafe('truncate table logs, users, organizations restart identity cascade');
  const { clickhouse } = await import('@repo/clickhouse');
  await clickhouse.command({ query: 'TRUNCATE TABLE logs SYNC' });
}
