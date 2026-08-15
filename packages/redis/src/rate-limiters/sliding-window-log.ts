import { redis } from '../client';
import type { RateLimitResponse } from './rate-limit';

export interface SlidingWindowLogPolicy {
  limit: number;
  windowSeconds: number;
  incrementBy?: number;
}

// https://redis.io/tutorials/howtos/ratelimiting/#2-sliding-window-log
const SLIDING_WINDOW_LOG_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local member = ARGV[4]
local incrementBy = tonumber(ARGV[5])
local windowStart = now - window * 1000

redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)
local count = redis.call('ZCARD', key)

if count + incrementBy <= limit then
  for index = 1, incrementBy do
    redis.call('ZADD', key, now, member .. ':' .. index)
  end
  redis.call('EXPIRE', key, window)
  return { 1, limit - count - incrementBy, 0 }
end

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retryAfterMs = window * 1000
if #oldest >= 2 then
  retryAfterMs = math.max(0, oldest[2] + window * 1000 - now)
end

return { 0, math.max(limit - count, 0), retryAfterMs }
`;

/**
 * Consumes a sliding window log for rate limiting.
 *
 * Records the timestamp of each request and removes entries that fall outside
 * the rolling window, providing precise enforcement without fixed-window
 * boundary spikes.
 *
 * It is commonly useful for high-value or security-sensitive
 * APIs where accuracy and request-level auditability justify higher memory use.
 *
 * @param key The unique key identifying the rate limit log.
 *
 * @param policy The sliding window log policy.
 *
 * @returns
 * A promise that resolves to the rate limit result.
 */
export async function consumeSlidingWindowLog(key: string, policy: SlidingWindowLogPolicy): Promise<RateLimitResponse> {
  const incrementBy = policy.incrementBy ?? 1;
  const now = Date.now(); // milliseconds to milliseconds

  // The provided key identifies the client's entire sliding-window log, while
  // member identifies one request inside that log.
  const member = `${now}:${Math.random()}`;

  const [allowedValue, remaining, retryAfterMs] = (await redis.eval(SLIDING_WINDOW_LOG_SCRIPT, {
    keys: [key],
    arguments: [
      policy.limit.toString(),
      policy.windowSeconds.toString(),
      now.toString(),
      member,
      incrementBy.toString(),
    ],
  })) as [number, number, number];

  const allowed = allowedValue === 1;

  return {
    limit: policy.limit,
    isLimited: !allowed,
    remainingQuota: remaining,
    retryAfterSeconds: allowed ? null : Math.max(0, Math.ceil(retryAfterMs / 1000)),
    delaySeconds: null,
  };
}
