/**
 * The result returned by every Redis-backed rate limiter.
 */
export interface RateLimitResponse {
  limit: number;
  isLimited: boolean;
  remainingQuota: number;
  retryAfterSeconds: number | null;
  delaySeconds: number | null;
}
