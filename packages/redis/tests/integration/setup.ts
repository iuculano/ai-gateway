import { afterAll, beforeAll } from 'bun:test';

function testRedisUrl(): string {
  const value = process.env.REDIS_PACKAGE_TEST_URL;
  if (!value) {
    throw new Error(
      'Missing REDIS_PACKAGE_TEST_URL. Point it at a dedicated logical database above 0, ' +
        'for example redis://host.docker.internal:6379/14.',
    );
  }

  const url = new URL(value);
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('REDIS_PACKAGE_TEST_URL must use the redis: or rediss: protocol.');
  }

  const match = /^\/(\d+)$/.exec(url.pathname);
  const database = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(database) || database <= 0) {
    throw new Error(
      'Refusing to run: REDIS_PACKAGE_TEST_URL must select a numbered database above 0, ' +
        'because the suite flushes that database.',
    );
  }

  return value;
}

process.env.REDIS_URL = testRedisUrl();

const { connectRedis, redis } = await import('../../index');

beforeAll(async () => {
  await connectRedis();
  await redis.flushDb();
});

afterAll(async () => {
  if (!redis.isOpen) {
    return;
  }

  await redis.flushDb();
  await redis.quit();
});
