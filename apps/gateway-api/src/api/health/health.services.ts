import { db } from '../../clients/drizzle';
import { nats } from '../../clients/nats';
import { redis } from '../../clients/redis';


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
  }

  catch {
    return false;
  }
}

/**
 * Checks if all required tables exist in the PostgreSQL database.
 *
 * @param requiredTables
 * An array of table names that must exist in the database.
 *
 * @returns
 * A promise that resolves to `true` if all required tables exist, otherwise
 * `false`.
 */
async function checkPostgresTables(requiredTables: string[]): Promise<boolean> {
  try {
    requiredTables = requiredTables || [];

    // Assume that the database connection is valid
    const result = await db.execute(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    );

    const rows = result.map((row) => row.table_name);
    const allExists = requiredTables.every(table => rows.includes(table));

    return allExists;
  }

  catch {
    return requiredTables.length === 0;
  }
}

/**
 * Checks the connectivity to the Redis server by sending a PING command.
 *
 * @returns
 * A promise that resolves to `true` if Redis is reachable, otherwise `false`.
 */
async function checkRedis(): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  }

  catch {
    return false;
  }
}

/**
 * Checks the connectivity to the NATS server by flushing the connection.
 *
 * @returns
 * A promise that resolves to `true` if NATS is reachable, otherwise `false`.
 */
async function checkNats(): Promise<boolean> {
  try {
    await nats.flush();
    return true;
  }

  catch {
    return false;
  }
}

export default {
  checkPostgres,
  checkPostgresTables,
  checkRedis,
  checkNats,
}
