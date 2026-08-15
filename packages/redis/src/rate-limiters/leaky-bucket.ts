import { redis } from '../client';
import type { RateLimitResponse } from './rate-limit';

export interface LeakyBucketPolicy {
  capacity: number;
  leakRate: number;
  mode: 'policing' | 'shaping';
  incrementBy?: number;
}

// https://redis.io/tutorials/howtos/ratelimiting/#5-leaky-bucket
const LEAKY_BUCKET_POLICING_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local leakRate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local incrementBy = tonumber(ARGV[4])
local values = redis.call('HMGET', key, 'level', 'lastLeak')
local level = tonumber(values[1]) or 0
local lastLeak = tonumber(values[2]) or now

level = math.max(0, level - math.max(0, now - lastLeak) * leakRate)

local allowed = 0
local retryAfterMs = 0
if level + incrementBy <= capacity then
  level = level + incrementBy
  allowed = 1
else
  retryAfterMs = math.ceil((level + incrementBy - capacity) / leakRate * 1000)
end

redis.call('HSET', key, 'level', tostring(level), 'lastLeak', tostring(now))
redis.call('EXPIRE', key, math.ceil(capacity / leakRate) + 1)

return { allowed, math.max(0, math.floor(capacity - level)), retryAfterMs, 0 }
`;

const LEAKY_BUCKET_SHAPING_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local leakRate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local incrementBy = tonumber(ARGV[4])
local nextFree = tonumber(redis.call('HGET', key, 'nextFree')) or now

nextFree = math.max(now, nextFree)
local delay = nextFree - now
local queueDepth = delay * leakRate
local allowed = 0
local retryAfterMs = 0
local delayMs = 0

if queueDepth + incrementBy <= capacity then
  delayMs = math.floor(delay * 1000)
  nextFree = nextFree + incrementBy / leakRate
  queueDepth = queueDepth + incrementBy
  allowed = 1
else
  retryAfterMs = math.ceil((queueDepth + incrementBy - capacity) / leakRate * 1000)
end

redis.call('HSET', key, 'nextFree', tostring(nextFree))
redis.call('EXPIRE', key, math.ceil(capacity / leakRate) + 1)

return { allowed, math.max(0, math.floor(capacity - queueDepth)), retryAfterMs, delayMs }
`;

/**
 * Consumes a leaky bucket for rate limiting.
 *
 * Drains requests from the bucket at a constant rate. In policing mode,
 * requests that exceed the bucket's capacity are rejected; in shaping mode,
 * accepted requests are delayed to maintain a steady processing rate.
 *
 * It is commonly useful for smoothing traffic and protecting downstream
 * services from sudden request bursts.
 *
 * @param key The unique key identifying the rate limit bucket.
 *
 * @param policy The leaky bucket policy.
 *
 * @returns
 * A promise that resolves to the rate limit result.
 */
export async function consumeLeakyBucket(key: string, policy: LeakyBucketPolicy): Promise<RateLimitResponse> {
  const incrementBy = policy.incrementBy ?? 1;
  const now = Date.now() / 1000; // milliseconds to seconds
  const script = policy.mode === 'shaping' ? LEAKY_BUCKET_SHAPING_SCRIPT : LEAKY_BUCKET_POLICING_SCRIPT;

  const [allowedValue, remaining, retryAfterMs, delayMs] = (await redis.eval(script, {
    keys: [key],
    arguments: [policy.capacity.toString(), policy.leakRate.toString(), now.toString(), incrementBy.toString()],
  })) as [number, number, number, number];

  const allowed = allowedValue === 1;

  return {
    limit: policy.capacity,
    isLimited: !allowed,
    remainingQuota: remaining,
    retryAfterSeconds: allowed ? null : Math.max(0, Math.ceil(retryAfterMs / 1000)),
    delaySeconds: allowed && delayMs > 0 ? delayMs / 1000 : null,
  };
}
