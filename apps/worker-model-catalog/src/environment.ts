import { z } from '@hono/zod-openapi';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8083),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'trace']).default('info'),
  WORKER_ENABLED: z.stringbool().default(true),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  CATALOG_SOURCE_URL: z.url().default('https://models.dev/catalog.json'),
  CATALOG_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  POSTGRES_CONNECTION_STRING: z.url(),
});

export const environment = environmentSchema.parse(process.env);
