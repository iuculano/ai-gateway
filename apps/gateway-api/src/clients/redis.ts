import { createHash } from 'node:crypto';
import { createClient } from 'redis';

const redis = await createClient()
  .on('error', (err) => console.log('Redis Client Error', err))
  .connect();


// Try to restrict the types to JSON-compatible values
type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
interface JsonObject { [key: string]: JsonValue }

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface JsonArray extends Array<JsonValue> {}

async function createCacheKey(prefix: string, data: JsonValue): Promise<string> {
  return prefix + createHash('sha1').update(JSON.stringify(data)).digest('hex');
}

export { redis, createCacheKey };
