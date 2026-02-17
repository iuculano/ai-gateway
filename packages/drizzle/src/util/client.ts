import { drizzle } from 'drizzle-orm/bun-sql';

export interface DatabaseOptions {
  connectionString?: string;
}

export function createDrizzleClient(options: DatabaseOptions = {}) {
  const connectionString = options.connectionString ?? process.env.POSTGRES_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error('Missing database connection string.');
  }

  return drizzle(connectionString);
}

export const db = createDrizzleClient();

export {
  sql,
  gte,
  gt,
  lte,
  lt,
  eq,
  not,
  and,
  or,
  asc,
  desc,
  sum,
  avg,
  min,
  max,
} from 'drizzle-orm';
