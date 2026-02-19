import { z } from '@hono/zod-openapi'

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().regex(/^\d+$/).default('3002s'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'trace']).default('info'),
  WORKER_ENABLED: z.coerce.boolean().default(true),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(10000),
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(25),

  POSTGRES_ENDPOINT: z.string().default('localhost:5432'),
  POSTGRES_DATABASE: z.string().default('ai_gateway'),
  POSTGRES_USERNAME: z.string().default('postgres'),
  POSTGRES_PASSWORD: z.string().default('postgres'),
});

export const environment = environmentSchema.parse(process.env);
