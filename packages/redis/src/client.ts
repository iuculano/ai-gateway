import { createClient } from 'redis';

function createRedisClient() {
  return createClient({
    // No explicit `database` option - whatever REDIS_URL names wins, and it
    // defaults to db 0 when the url carries no path. The integration suites
    // rely on that: this package's README points them at /14 and /15 so they
    // can run beside each other without sharing keys.
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    password: process.env.REDIS_PASSWORD,
    username: process.env.REDIS_USERNAME,
  }).on('error', (err: unknown) => console.log('Redis Client Error', err));
}

export type RedisClient = ReturnType<typeof createRedisClient>;

export const redis = createRedisClient();

let connection: Promise<RedisClient> | undefined;

/**
 * Opens the connection, once.
 *
 * Idempotent - this won't open a new connection if one is already open.
 */
export function connectRedis(): Promise<RedisClient> {
  connection ??= redis.connect();

  return connection;
}
