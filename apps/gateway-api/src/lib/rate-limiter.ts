import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
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
  isLimited: boolean;
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
    useRedisPackage: true,
  });

  limiterCache.set(cacheKey, limiter);
  return limiter;
}

export async function enforceRateLimit(key: string, policy: RateLimitPolicy): Promise<RateLimitResult> {
  const limiter = await getRateLimiter(policy);

  let isLimited = false;
  let response;
  try {
    response = await limiter.consume(key, 1);
  } 
  
  catch (err) {
    // Try to figure out if we're limited, or something is actually wrong.
    //
    // If we're rate limited, seems like the promise will reject and we'll
    // get a RateLimiterRes object.
    //
    // Asumme if we don't get that, something else is wrong - let the error
    // handler eat it.
    if (!(err instanceof RateLimiterRes)) {
      throw err;
    }

    isLimited = true;
    response = err;
  }

  // We always consume by 1, so it's fine to use consumedPoints directly here.
  return {
    isLimited: isLimited,
    consumedQuota: response.consumedPoints,
    remainingQuota: response.remainingPoints,
    secondsUntilReset: Math.ceil(response.msBeforeNext / 1000),
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