import { z } from '@hono/zod-openapi';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'trace']).default('info'),
  WORKER_ENABLED: z.stringbool().default(true),

  // Hourly. models.dev is a published reference, not a live feed - prices move
  // on the order of weeks - and every tick that finds nothing costs one
  // conditional request, so there is little to gain from going faster.
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),

  // catalog.json rather than api.json or models.json. The other two are its
  // halves: api.json is exactly `catalog.providers` and models.json is exactly
  // `catalog.models`. Taking the whole thing is one request, one ETag, and one
  // atomic snapshot - fetching the halves separately would eventually pair
  // offerings from one revision with definitions from another.
  CATALOG_SOURCE_URL: z.url().default('https://models.dev/catalog.json'),

  // The body is ~4 MB and is fetched whole; there is no per-provider endpoint.
  CATALOG_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  POSTGRES_CONNECTION_STRING: z.url(),
});

export const environment = environmentSchema.parse(process.env);
