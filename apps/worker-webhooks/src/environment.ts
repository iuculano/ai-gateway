import { z } from '@hono/zod-openapi';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8082),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  WORKER_ENABLED: z.stringbool().default(true),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(25),
  WORKER_DELIVERY_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  POSTGRES_CONNECTION_STRING: z.url(),
});

export type Environment = z.infer<typeof environmentSchema>;

export function loadEnvironment(input: NodeJS.ProcessEnv = process.env): Environment {
  const result = environmentSchema.safeParse(input);

  if (!result.success) {
    console.error('Invalid environment configuration:', z.prettifyError(result.error));
    process.exit(1);
  }

  return result.data;
}

export const environment = Object.freeze(loadEnvironment());
