import { clickhouse } from '@repo/clickhouse';
import { db } from '@repo/drizzle';

/**
 * Checks the connectivity to the PostgreSQL database by executing a simple
 * query.
 *
 * @returns
 * A promise that resolves to `true` if the database is reachable, otherwise
 * `false`.
 */
async function checkPostgres(): Promise<boolean> {
  try {
    await db.execute('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks that ClickHouse answers a query.
 *
 * @returns
 * A promise that resolves to `true` if ClickHouse is reachable, otherwise `false`.
 */
async function checkClickHouse(): Promise<boolean> {
  try {
    return (await clickhouse.ping()).success;
  } catch {
    return false;
  }
}

export default {
  checkPostgres,
  checkClickHouse,
};
