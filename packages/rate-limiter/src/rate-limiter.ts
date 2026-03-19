import { consumeFixedWindowCounter } from '@repo/redis';

interface RateLimitPolicy {
  quota: number;
  windowSeconds: number;
}

interface RateLimitResult {
  limit: number;
  isLimited: boolean;
  consumedQuota: number;
  remainingQuota: number;
  secondsUntilReset: number;
}

export async function enforceRateLimit(key: string, policy: RateLimitPolicy): Promise<RateLimitResult> {
  const redisKey = `rate-limit:${key}`;

  const result = await consumeFixedWindowCounter(redisKey, {
    limit: policy.quota,
    windowSeconds: policy.windowSeconds,
  });

  return {
    limit: result.limit,
    isLimited: result.count > policy.quota,
    consumedQuota: result.count,
    remainingQuota: result.remaining,
    secondsUntilReset: result.secondsUntilReset,
  };
}

export async function parseRateLimitHeader(header: string): Promise<RateLimitPolicy | undefined> {
  // Expected format: "<quota>;w=<window>"
  // For example:     "1000;w=3600"
  const [quota, window] = header.split(';');
  if (!quota || !window) {
    return undefined;
  }

  if (!window.startsWith('w=')) {
    return undefined;
  }

  // Reject negative or zero values, just in case.
  const parsedQuota = parseInt(quota, 10);
  if (Number.isNaN(parsedQuota) || parsedQuota <= 0) {
    return undefined;
  }

  const parsedWindow = parseInt(window.slice(2), 10);
  if (Number.isNaN(parsedWindow) || parsedWindow <= 0) {
    return undefined;
  }

  return {
    quota: parsedQuota,
    windowSeconds: parsedWindow,
  };
}

