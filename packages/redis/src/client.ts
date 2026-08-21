import { createClient } from 'redis';

function createRedisClient() {
  return createClient({
    // No database selection: everything lives in db 0, redis' default.
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    password: process.env.REDIS_PASSWORD,
    username: process.env.REDIS_USERNAME,
  }).on('error', (err: unknown) => console.log('Redis Client Error', err));
}

export type RedisClient = ReturnType<typeof createRedisClient>;

let client: RedisClient | undefined;

/**
 * The shared client, constructed on first use rather than at import time.
 *
 * Reading REDIS_URL during module evaluation meant whoever imported this first
 * decided the address, and anything that populates the environment later - a
 * dev server that loads .env as part of its own startup, a test that sets the
 * variable in a hook - lost the race and silently got the localhost fallback
 * instead. Deferring the read to first use means the value is whatever the
 * environment holds by the time somebody actually talks to redis.
 *
 * Methods are bound to the real client so `this` is never the proxy; node-redis
 * leans on private fields internally and those throw when read off a Proxy.
 */
export const redis: RedisClient = new Proxy({} as RedisClient, {
  get(_target, property) {
    client ??= createRedisClient();

    const value = Reflect.get(client, property);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});

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
