import { z } from '@hono/zod-openapi';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8084),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'trace']).default('info'),
  WORKER_ENABLED: z.stringbool().default(true),

  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  ROLLUP_TRAILING_WINDOW_HOURS: z.coerce.number().int().positive().default(3),
  ROLLUP_CHUNK_HOURS: z.coerce.number().int().positive().default(24),

  POSTGRES_CONNECTION_STRING: z.url(),
});

export const environment = environmentSchema.parse(process.env);
