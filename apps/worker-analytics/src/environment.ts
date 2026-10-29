import { z } from '@hono/zod-openapi';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8084),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'trace']).default('info'),
  WORKER_ENABLED: z.stringbool().default(true),

  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  SYNC_BATCH_ROWS: z.coerce.number().int().positive().default(20_000),

  POSTGRES_CONNECTION_STRING: z.url(),

  CLICKHOUSE_URL: z.url(),
  CLICKHOUSE_USER: z.string().default('default'),
  CLICKHOUSE_PASSWORD: z.string().default(''),
  CLICKHOUSE_DATABASE: z.string().default('ai_gateway'),
});

export const environment = environmentSchema.parse(process.env);
