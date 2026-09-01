import { createHash } from 'node:crypto';

/**
 * Generates a cache key by combining a prefix with a SHA-256 hash of the
 * provided data.
 *
 * @param prefix
 * The prefix to prepend to the cache key.
 *
 * @param data
 * The JSON-compatible value to hash for the cache key.
 *
 * @returns
 * The generated cache key string.
 */
export function createCacheKey(prefix: string, data: unknown): string {
  const json = JSON.stringify(data);
  if (json === undefined) {
    throw new Error('Cache key data is not JSON-serializable');
  }

  return prefix + createHash('sha256').update(json).digest('hex');
}
