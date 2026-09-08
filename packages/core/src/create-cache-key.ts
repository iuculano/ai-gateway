import { createHash } from 'node:crypto';
import { configure } from 'safe-stable-stringify';

const stringify = configure({ circularValue: Error });

/**
 * Generates a cache key by combining a prefix with a SHA-256 hash of the
 * provided data, with object keys sorted recursively.
 *
 * @param prefix
 * The prefix to prepend to the cache key.
 *
 * @param data
 * The value to hash for the cache key. BigInt is serialized as a JSON number.
 *
 * @returns
 * The generated cache key string.
 */
export function createCacheKey(prefix: string, data: unknown): string {
  const json = stringify(data);
  if (json === undefined) {
    throw new Error('Cache key data is not JSON-serializable');
  }

  return prefix + createHash('sha256').update(json).digest('hex');
}
