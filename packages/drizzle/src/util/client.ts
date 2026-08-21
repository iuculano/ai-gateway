import { drizzle } from 'drizzle-orm/bun-sql';

export interface DatabaseOptions {
  connectionString?: string;
}

export function createDrizzleClient(options: DatabaseOptions = {}) {
  const connectionString = options.connectionString ?? process.env.POSTGRES_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error('Missing database connection string. Set POSTGRES_CONNECTION_STRING.');
  }

  return drizzle(connectionString);
}

export type DrizzleClient = ReturnType<typeof createDrizzleClient>;

let client: DrizzleClient | undefined;

/**
 * The shared client, constructed on first use rather than at import time.
 *
 * Eager construction meant that merely importing this module - which every
 * consumer does, if only for the `eq`/`and` helpers re-exported below - threw
 * when POSTGRES_CONNECTION_STRING was unset. That fired during module
 * evaluation, so it beat the app's own environment validation and surfaced as
 * a bare error from inside this package instead of a named missing variable.
 *
 * Methods are bound to the real client so `this` is never the proxy; drizzle
 * leans on private fields internally and those throw when read off a Proxy.
 */
export const db: DrizzleClient = new Proxy({} as DrizzleClient, {
  get(_target, property) {
    client ??= createDrizzleClient();

    const value = Reflect.get(client, property);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});

export {
  and,
  asc,
  avg,
  desc,
  eq,
  getTableName,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  max,
  min,
  not,
  notInArray,
  or,
  sql,
  sum,
} from 'drizzle-orm';
