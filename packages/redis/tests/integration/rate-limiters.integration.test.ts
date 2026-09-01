import { describe, expect, test } from 'bun:test';
import {
  connectRedis,
  consumeFixedWindowCounter,
  consumeLeakyBucket,
  consumeSlidingWindowCounter,
  consumeSlidingWindowLog,
  consumeTokenBucket,
  redis,
} from '../../index';

function key(name: string): string {
  return `tests:rate-limiters:${name}:${crypto.randomUUID()}`;
}

describe('Redis client', () => {
  test('connectRedis is idempotent', async () => {
    const first = connectRedis();
    const second = connectRedis();

    expect(first).toBe(second);
    await expect(first).resolves.toBeDefined();
    expect(redis.isReady).toBe(true);
  });
});

describe('fixed-window counter', () => {
  test('allows through the limit, counts rejected attempts, and sets an expiry', async () => {
    const redisKey = key('fixed-window');
    const policy = { limit: 2, windowSeconds: 30 };

    await expect(consumeFixedWindowCounter(redisKey, policy)).resolves.toEqual({
      limit: 2,
      isLimited: false,
      remainingQuota: 1,
      retryAfterSeconds: null,
      delaySeconds: null,
    });
    await expect(consumeFixedWindowCounter(redisKey, policy)).resolves.toEqual({
      limit: 2,
      isLimited: false,
      remainingQuota: 0,
      retryAfterSeconds: null,
      delaySeconds: null,
    });

    const rejected = await consumeFixedWindowCounter(redisKey, policy);
    expect(rejected).toMatchObject({
      limit: 2,
      isLimited: true,
      remainingQuota: 0,
      delaySeconds: null,
    });
    expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
    expect(rejected.retryAfterSeconds).toBeLessThanOrEqual(30);
    expect(await redis.get(redisKey)).toBe('3');
    expect(await redis.ttl(redisKey)).toBeGreaterThan(0);
  });

  test('enforces custom increments atomically under concurrency', async () => {
    const redisKey = key('fixed-window-concurrent');
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        consumeFixedWindowCounter(redisKey, { limit: 6, windowSeconds: 30, incrementBy: 2 }),
      ),
    );

    expect(results.filter((result) => !result.isLimited)).toHaveLength(3);
    expect(results.filter((result) => result.isLimited)).toHaveLength(7);
    expect(await redis.get(redisKey)).toBe('20');
  });
});

describe('sliding-window log', () => {
  test('records accepted increments and leaves the log unchanged on rejection', async () => {
    const redisKey = key('sliding-log');
    const policy = { limit: 3, windowSeconds: 30 };

    const first = await consumeSlidingWindowLog(redisKey, { ...policy, incrementBy: 2 });
    const second = await consumeSlidingWindowLog(redisKey, policy);
    const rejected = await consumeSlidingWindowLog(redisKey, policy);

    expect(first).toMatchObject({ isLimited: false, remainingQuota: 1 });
    expect(second).toMatchObject({ isLimited: false, remainingQuota: 0 });
    expect(rejected).toMatchObject({ isLimited: true, remainingQuota: 0 });
    expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
    expect(rejected.retryAfterSeconds).toBeLessThanOrEqual(30);
    expect(await redis.zCard(redisKey)).toBe(3);
    expect(await redis.ttl(redisKey)).toBeGreaterThan(0);
  });

  test('evicts entries outside the rolling window before enforcing the limit', async () => {
    const redisKey = key('sliding-log-expired');
    const now = Date.now();
    await redis.zAdd(redisKey, { score: now - 11_000, value: 'expired' });

    const result = await consumeSlidingWindowLog(redisKey, { limit: 1, windowSeconds: 10 });

    expect(result).toMatchObject({ isLimited: false, remainingQuota: 0 });
    expect(await redis.zCard(redisKey)).toBe(1);
  });
});

describe('sliding-window counter', () => {
  test('rejects an increment without adding it to the current bucket', async () => {
    const redisKey = key('sliding-counter');
    const windowSeconds = 3600;
    const policy = { limit: 3, windowSeconds };

    const first = await consumeSlidingWindowCounter(redisKey, { ...policy, incrementBy: 2 });
    const second = await consumeSlidingWindowCounter(redisKey, policy);
    const rejected = await consumeSlidingWindowCounter(redisKey, policy);

    expect(first).toMatchObject({ isLimited: false, remainingQuota: 1 });
    expect(second).toMatchObject({ isLimited: false, remainingQuota: 0 });
    expect(rejected).toMatchObject({ isLimited: true, remainingQuota: 0 });
    expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
    expect(rejected.retryAfterSeconds).toBeLessThanOrEqual(windowSeconds);

    const bucketKeys = await redis.keys(`{${redisKey}}:*`);
    expect(bucketKeys).toHaveLength(1);
    expect(await redis.mGet(bucketKeys)).toEqual(['3']);
  });
});

describe('token bucket', () => {
  test('allows a burst up to capacity and reports refill time when empty', async () => {
    const redisKey = key('token-bucket');
    const policy = { capacity: 3, refillRate: 0.01 };

    const first = await consumeTokenBucket(redisKey, { ...policy, incrementBy: 2 });
    const second = await consumeTokenBucket(redisKey, policy);
    const rejected = await consumeTokenBucket(redisKey, policy);

    expect(first).toMatchObject({ isLimited: false, remainingQuota: 1 });
    expect(second).toMatchObject({ isLimited: false, remainingQuota: 0 });
    expect(rejected).toMatchObject({ isLimited: true, remainingQuota: 0, delaySeconds: null });
    expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
    expect(await redis.ttl(redisKey)).toBeGreaterThan(0);
  });

  test('refills from elapsed time without exceeding capacity', async () => {
    const redisKey = key('token-bucket-refill');
    await redis.hSet(redisKey, {
      tokens: '0',
      lastRefill: String(Date.now() / 1000 - 10),
    });

    const result = await consumeTokenBucket(redisKey, { capacity: 3, refillRate: 1, incrementBy: 2 });

    expect(result).toEqual({
      limit: 3,
      isLimited: false,
      remainingQuota: 1,
      retryAfterSeconds: null,
      delaySeconds: null,
    });
  });
});

describe('leaky bucket', () => {
  test('policing mode rejects overflow and reports when capacity returns', async () => {
    const redisKey = key('leaky-policing');
    const policy = { capacity: 3, leakRate: 0.01, mode: 'policing' as const };

    const first = await consumeLeakyBucket(redisKey, { ...policy, incrementBy: 2 });
    const rejected = await consumeLeakyBucket(redisKey, { ...policy, incrementBy: 2 });

    expect(first).toMatchObject({ isLimited: false, remainingQuota: 1, delaySeconds: null });
    expect(rejected).toMatchObject({ isLimited: true, remainingQuota: 1, delaySeconds: null });
    expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
    expect(await redis.ttl(redisKey)).toBeGreaterThan(0);
  });

  test('policing mode drains the stored level using elapsed time', async () => {
    const redisKey = key('leaky-policing-drain');
    await redis.hSet(redisKey, {
      level: '3',
      lastLeak: String(Date.now() / 1000 - 10),
    });

    const result = await consumeLeakyBucket(redisKey, {
      capacity: 3,
      leakRate: 1,
      mode: 'policing',
      incrementBy: 2,
    });

    expect(result).toEqual({
      limit: 3,
      isLimited: false,
      remainingQuota: 1,
      retryAfterSeconds: null,
      delaySeconds: null,
    });
  });

  test('shaping mode delays queued work and rejects work beyond capacity', async () => {
    const redisKey = key('leaky-shaping');
    const policy = { capacity: 3, leakRate: 1, mode: 'shaping' as const };

    const immediate = await consumeLeakyBucket(redisKey, policy);
    const delayed = await consumeLeakyBucket(redisKey, policy);
    const rejected = await consumeLeakyBucket(redisKey, { ...policy, incrementBy: 2 });

    expect(immediate).toMatchObject({ isLimited: false, remainingQuota: 2, delaySeconds: null });
    expect(delayed).toMatchObject({ isLimited: false, remainingQuota: 1 });
    expect(delayed.delaySeconds).toBeGreaterThan(0);
    expect(delayed.delaySeconds).toBeLessThanOrEqual(1);
    expect(rejected).toMatchObject({ isLimited: true, remainingQuota: 1, delaySeconds: null });
    expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
  });
});
