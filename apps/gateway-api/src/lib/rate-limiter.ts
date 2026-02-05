import { RateLimiterRedis } from 'rate-limiter-flexible';
import { LRUCache } from "lru-cache";
import { createCacheKey, redis } from "@lib/redis";


// Hmm, this could be heavy - keep this in mind...
// It might be easy to thrash this cache...
const limiterCache = new LRUCache<string, RateLimiterRedis>({
  max: 1000,
  ttl: 1000 * 60 * 60, // 1 hour
});

interface RateLimitPolicy {
  quota: number;
  windowSeconds: number;
}

interface RateLimitResult {
  consumedQuota: number;
  remainingQuota: number;
  secondsUntilReset: number;
}

async function getRateLimiter(policy: RateLimitPolicy) {
  const cacheKey = await createCacheKey('rate-limiter:', policy);
  const existing = limiterCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const limiter = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: 'rate-limiter',
    points: policy.quota,
    duration: policy.windowSeconds,
  });

  limiterCache.set(cacheKey, limiter);
  return limiter;
}

export async function enforceRateLimit(key: string, policy: RateLimitPolicy): Promise<RateLimitResult> {
  const limiter = await getRateLimiter(policy);
  const remaining = await limiter.consume(key, 1);

  // We always consume by 1, so it's fine to use consumedPoints directly here.
  return {
    consumedQuota: remaining.consumedPoints,
    remainingQuota: remaining.remainingPoints,
    secondsUntilReset: Math.ceil(remaining.msBeforeNext / 1000),
  }
}

//*
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
  const parsedQuota = parseInt(quota);
  if (isNaN(parsedQuota) || parsedQuota <= 0) {
    return undefined;
  }

  const parsedWindow = parseInt(window.slice(2));
  if (isNaN(parsedWindow) || parsedWindow <= 0) {
    return undefined;
  }

  return {
    quota: parsedQuota,
    windowSeconds: parsedWindow,
  };
}