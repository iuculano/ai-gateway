import { db, sql } from '@repo/drizzle';
import { redis } from '@repo/redis';

type Drizzle = typeof db;
type Redis = typeof redis;

export class HealthServices {
  constructor(
    private db: Drizzle,
    private redis: Redis,
  ) {}

  /**
   * Checks the connectivity to the PostgreSQL database by executing a simple
   * query.
   *
   * @returns
   * A promise that resolves to `true` if the database is reachable, otherwise
   * `false`.
   */
  async checkPostgres(): Promise<boolean> {
    try {
      await this.db.execute(sql`SELECT 1`);
      return true;
    } catch {
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
  async checkPostgresTables(requiredTables: string[]): Promise<boolean> {
    try {
      requiredTables = requiredTables || [];

      // Assume that the database connection is valid and just grab the table
      // names.
      const result = await this.db.execute(sql`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
      `);

      const rows = result.map((row) => row.table_name as string);
      const allExists = requiredTables.every((table) => rows.includes(table));

      return allExists;
    } catch {
      // If drizzle threw an exception, we probably have a connection issue and
      // have failed the earlier checkPostgres() check.
      //
      // We can still just return false in this case.
      return false;
    }
  }

  /**
   * Checks the connectivity to the Redis server by sending a PING command.
   *
   * @returns
   * A promise that resolves to `true` if Redis is reachable, otherwise `false`.
   */
  async checkRedis(): Promise<boolean> {
    try {
      await this.redis.ping();
      return true;
    } catch {
      return false;
    }
  }
}

export default new HealthServices(db, redis);
