import { redis } from '../client';
import type { RateLimitResponse } from './rate-limit';

export interface SlidingWindowCounterPolicy {
  limit: number;
  windowSeconds: number;
  incrementBy?: number;
}

// https://redis.io/tutorials/howtos/ratelimiting/#3-sliding-window-counter
const SLIDING_WINDOW_COUNTER_SCRIPT = `
local currentKey = KEYS[1]
local previousKey = KEYS[2]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local elapsed = tonumber(ARGV[3])
local incrementBy = tonumber(ARGV[4])

local previousCount = tonumber(redis.call('GET', previousKey) or '0') or 0
local currentCount = tonumber(redis.call('GET', currentKey) or '0') or 0
local weightedPrevious = previousCount * (1 - elapsed)
local estimated = weightedPrevious + currentCount

if estimated + incrementBy > limit then
  return { 0, math.max(0, math.floor(limit - estimated)) }
end

local newCount = redis.call('INCRBY', currentKey, incrementBy)
if newCount == incrementBy then
  redis.call('EXPIRE', currentKey, window * 2)
end

local newEstimate = weightedPrevious + newCount
return { 1, math.max(0, math.floor(limit - newEstimate)) }
`;

/**
 * Consumes a sliding window counter for rate limiting.
 *
 * Estimates usage across the current and previous windows using a weighted
 * count, smoothing boundary spikes while maintaining a low memory footprint.
 *
 * It is commonly useful for general-purpose API rate limiting where accuracy
 * and memory efficiency both matter.
 *
 * @param key The unique key identifying the rate limit counter.
 *
 * @param policy The sliding window counter policy.
 *
 * @returns
 * A promise that resolves to the rate limit result.
 */
export async function consumeSlidingWindowCounter(
  key: string,
  policy: SlidingWindowCounterPolicy,
): Promise<RateLimitResponse> {
  const incrementBy = policy.incrementBy ?? 1;
  const now = Math.floor(Date.now() / 1000);
  const currentWindow = Math.floor(now / policy.windowSeconds);
  const elapsed = (now % policy.windowSeconds) / policy.windowSeconds;
  const currentKey = `{${key}}:${currentWindow}`;
  const previousKey = `{${key}}:${currentWindow - 1}`;

  const [allowedValue, remaining] = (await redis.eval(SLIDING_WINDOW_COUNTER_SCRIPT, {
    keys: [currentKey, previousKey],
    arguments: [policy.limit.toString(), policy.windowSeconds.toString(), elapsed.toString(), incrementBy.toString()],
  })) as [number, number];

  const allowed = allowedValue === 1;

  return {
    limit: policy.limit,
    isLimited: !allowed,
    remainingQuota: remaining,
    retryAfterSeconds: allowed ? null : Math.max(1, Math.ceil(policy.windowSeconds * (1 - elapsed))),
    delaySeconds: null,
  };
}
