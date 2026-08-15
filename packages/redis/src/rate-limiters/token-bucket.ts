import { redis } from '../client';
import type { RateLimitResponse } from './rate-limit';

export interface TokenBucketPolicy {
  capacity: number;
  refillRate: number;
  incrementBy?: number;
}

// https://redis.io/tutorials/howtos/ratelimiting/#4-token-bucket
const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local incrementBy = tonumber(ARGV[4])
local values = redis.call('HMGET', key, 'tokens', 'lastRefill')
local tokens = tonumber(values[1]) or capacity
local lastRefill = tonumber(values[2]) or now

tokens = math.min(capacity, tokens + math.max(0, now - lastRefill) * refillRate)

local allowed = 0
local retryAfterMs = 0
if tokens >= incrementBy then
  tokens = tokens - incrementBy
  allowed = 1
else
  retryAfterMs = math.ceil((incrementBy - tokens) / refillRate * 1000)
end

redis.call('HSET', key, 'tokens', tostring(tokens), 'lastRefill', tostring(now))
redis.call('EXPIRE', key, math.ceil(capacity / refillRate) + 1)

return { allowed, math.max(0, math.floor(tokens)), retryAfterMs }
`;

/**
 * Consumes a token bucket for rate limiting.
 *
 * Refills tokens at a constant rate up to the bucket's capacity and consumes
 * tokens for each accepted request.
 *
 * It is commonly useful for APIs that permit controlled traffic bursts while
 * enforcing a steady long-term request rate.
 *
 * @param key The unique key identifying the token bucket.
 *
 * @param policy The token bucket policy.
 *
 * @returns
 * A promise that resolves to the rate limit result.
 */
export async function consumeTokenBucket(key: string, policy: TokenBucketPolicy): Promise<RateLimitResponse> {
  const incrementBy = policy.incrementBy ?? 1;
  const now = Date.now() / 1000;

  const [allowedValue, remaining, retryAfterMs] = (await redis.eval(TOKEN_BUCKET_SCRIPT, {
    keys: [key],
    arguments: [policy.capacity.toString(), policy.refillRate.toString(), now.toString(), incrementBy.toString()],
  })) as [number, number, number];

  const allowed = allowedValue === 1;

  return {
    limit: policy.capacity,
    isLimited: !allowed,
    remainingQuota: remaining,
    retryAfterSeconds: allowed ? null : Math.max(0, Math.ceil(retryAfterMs / 1000)),
    delaySeconds: null,
  };
}
