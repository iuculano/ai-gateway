import { redis } from './redis';

export interface FixedWindowCounterPolicy {
  limit: number;
  windowSeconds: number;
  incrementBy?: number;
}

export interface FixedWindowCounterResult {
  count: number;
  remaining: number;
  limit: number;
  secondsUntilReset: number;
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

local ttl = redis.call('TTL', key)
if ttl < 0 then
  ttl = window
end

return { count, math.max(limit - count, 0), ttl }
`;

export async function consumeFixedWindowCounter(
  key: string,
  policy: FixedWindowCounterPolicy,
): Promise<FixedWindowCounterResult> {
  const incrementBy = policy.incrementBy ?? 1;

  const [count, remaining, ttl] = await redis.eval(FIXED_WINDOW_COUNTER_SCRIPT, {
    keys: [key],
    arguments: [
      policy.limit.toString(),
      policy.windowSeconds.toString(),
      incrementBy.toString(),
    ],
  }) as [number, number, number];

  return {
    count,
    remaining,
    limit: policy.limit,
    secondsUntilReset: ttl,
  };
}
