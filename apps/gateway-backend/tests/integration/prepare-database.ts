/**
 * Creates and migrates the database the integration tier runs against.
 *
 * Separate from the development database on purpose - the suite truncates every
 * table between tests, and `ai_gateway` holds work somebody wants to keep.
 *
 * Re-runnable. Run it after a schema change, and once after a fresh
 * `docker compose up`:
 *
 *   bun run test:db:setup
 */
import { SQL } from 'bun';

const adminConnectionString = process.env.POSTGRES_TEST_ADMIN_CONNECTION_STRING;
if (!adminConnectionString) {
  throw new Error(
    'Missing POSTGRES_TEST_ADMIN_CONNECTION_STRING. Pass it inline, for example:\n' +
      '  POSTGRES_TEST_ADMIN_CONNECTION_STRING=postgresql://postgres:postgres@localhost:5432/ai_gateway_test \\\n' +
      '    bun run test:db:setup',
  );
}

const url = new URL(adminConnectionString);
const databaseName = url.pathname.replace(/^\//, '');

if (!databaseName.endsWith('_test')) {
  throw new Error(`Refusing to prepare "${databaseName}": an integration database's name must end in "_test".`);
}

const drizzlePackage = new URL('../../../../packages/drizzle/', import.meta.url);

async function run(command: string[], environment: Record<string, string>): Promise<void> {
  const result = Bun.spawnSync(command, {
    cwd: drizzlePackage.pathname,
    env: { ...process.env, ...environment },
    stdout: 'inherit',
    stderr: 'inherit',
  });

  if (result.exitCode !== 0) {
    throw new Error(`${command.join(' ')} exited ${result.exitCode}`);
  }
}

// Connect to the maintenance database to create the test one - postgres has no
// "create database if not exists".
const maintenanceUrl = new URL(adminConnectionString);
maintenanceUrl.pathname = '/postgres';
const maintenance = new SQL(maintenanceUrl.toString());

try {
  const existing = await maintenance`select 1 from pg_database where datname = ${databaseName}`;

  if (existing.length === 0) {
    await maintenance.unsafe(`create database "${databaseName}"`);
    console.log(`created database ${databaseName}`);
  }
} finally {
  await maintenance.close();
}

await run(['bunx', '--bun', 'drizzle-kit', 'push', '--config=drizzle.config.ts', '--force'], {
  POSTGRES_ADMIN_CONNECTION_STRING: adminConnectionString,
});

console.log(`\n${databaseName} is ready.`);
