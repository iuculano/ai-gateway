import { createClient } from 'redis';

/**
 * The shared, underlying client.
 */
export const redis = createClient({
  // No database selection: everything lives in db 0, redis' default.
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  password: process.env.REDIS_PASSWORD,
  username: process.env.REDIS_USERNAME,
}).on('error', (err: unknown) => console.log('Redis Client Error', err));

let connection: Promise<unknown> | undefined;

/**
 * Opens the connection, once.
 *
 * Idempotent - this won't open a new connection if one is already open.
 */
export function connectRedis(): Promise<unknown> {
  connection ??= redis.connect();

  return connection;
}
