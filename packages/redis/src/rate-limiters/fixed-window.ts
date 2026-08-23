import { redis } from '../client';
import type { RateLimitResponse } from './rate-limit';

export interface FixedWindowCounterPolicy {
  limit: number;
  windowSeconds: number;
  incrementBy?: number;
}

// https://redis.io/tutorials/howtos/ratelimiting/#1-fixed-window-counter
const FIXED_WINDOW_COUNTER_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local incrementBy = tonumber(ARGV[3])

local count = redis.call('INCRBY', key, incrementBy)
if count == incrementBy then
  redis.call('EXPIRE', key, window)
end

local pttl = redis.call('PTTL', key)
if pttl < 0 then
  pttl = window * 1000
end

return { count, math.max(limit - count, 0), pttl }
`;

/**
 * Consumes a fixed window counter for rate limiting.
 *
 * Counts requests within discrete time intervals and rejects requests once the
 * configured limit is exceeded. When the window expires, the counter resets and
 * requests are allowed again.
 *
 * It is commonly useful for simple API quotas, login throttling, and other
 * limits where low overhead matters more than precise handling at window
 * boundaries.
 *
 * @param key
 * The unique key identifying the rate limit counter.
 *
 * @param policy
 * The fixed window counter policy.
 *
 * @returns
 * The allowance decision, remaining quota, and reset timing.
 */
export async function consumeFixedWindowCounter(
  key: string,
  policy: FixedWindowCounterPolicy,
): Promise<RateLimitResponse> {
  const incrementBy = policy.incrementBy ?? 1;

  const [count, remaining, pttl] = (await redis.eval(FIXED_WINDOW_COUNTER_SCRIPT, {
    keys: [key],
    arguments: [policy.limit.toString(), policy.windowSeconds.toString(), incrementBy.toString()],
  })) as [number, number, number];

  const allowed = count <= policy.limit;
  const secondsUntilReset = Math.max(0, Math.ceil(pttl / 1000));

  return {
    limit: policy.limit,
    isLimited: !allowed,
    remainingQuota: remaining,
    retryAfterSeconds: allowed ? null : secondsUntilReset,
    delaySeconds: null,
  };
}
