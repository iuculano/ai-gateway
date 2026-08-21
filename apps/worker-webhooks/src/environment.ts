import { z } from '@hono/zod-openapi';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'trace']).default('info'),
  WORKER_ENABLED: z.stringbool().default(true),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(10000),
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(25),
  WORKER_DELIVERY_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  POSTGRES_CONNECTION_STRING: z.url(),
});

export const environment = environmentSchema.parse(process.env);
