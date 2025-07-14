import { createHash } from 'node:crypto';
import { createClient } from 'redis';
import { environment } from '../utils/environment';


const redis = await createClient({
  url: environment.REDIS_URL || 'redis://localhost:6379',
  password: environment.REDIS_PASSWORD,
  username: environment.REDIS_USERNAME,
  database: environment.REDIS_DB,
})
.on('error', (err) => console.log('Redis Client Error', err))
.connect();


// Try to restrict the types to JSON-compatible values
type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
interface JsonObject { [key: string]: JsonValue }

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface JsonArray extends Array<JsonValue> {}

/**
 * Generates a cache key by combining a prefix with a SHA-1 hash of the provided
 * data.
 *
 * @param prefix
 * The prefix to prepend to the cache key.
 *
 * @param data
 * The JSON-compatible value to hash for the cache key.
 *
 * @returns
 * A promise that resolves to the generated cache key string.
 */
async function createCacheKey(prefix: string, data: JsonValue): Promise<string> {
  return prefix + createHash('sha1').update(JSON.stringify(data)).digest('hex');
}

export {
  redis,
  createCacheKey
};
