import { createHash } from 'node:crypto';

/**
 * Generates a cache key by combining a prefix with a SHA-256 hash of the
 * provided data.
 *
 * @param prefix The prefix to prepend to the cache key.
 *
 * @param data The JSON-compatible value to hash for the cache key.
 *
 * @returns
 * The generated cache key string.
 */
export function createCacheKey(prefix: string, data: unknown): string {
  let containsNonJsonValue = false;
  let json: string | undefined;

  try {
    json = JSON.stringify(data, (_key, value: unknown) => {
      if (
        value === undefined ||
        typeof value === 'function' ||
        typeof value === 'symbol' ||
        (typeof value === 'number' && !Number.isFinite(value))
      ) {
        containsNonJsonValue = true;
      }

      return value;
    });
  } catch {
    throw new Error('Cache key data is not JSON-serializable');
  }

  if (json === undefined || containsNonJsonValue) {
    throw new Error('Cache key data is not JSON-serializable');
  }

  return prefix + createHash('sha256').update(json).digest('hex');
}
