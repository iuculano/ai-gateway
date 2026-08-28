import { z } from '@hono/zod-openapi';

/**
 * Validated set of environment variables.
 *
 * Ensures that all required environment variables are present and correctly
 * typed.
 *
 * TLDR: Use this instead of process.env.
 */
const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().regex(/^\d+$/).default('8080'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'trace']).default('info'),

  POSTGRES_CONNECTION_STRING: z.url(),

  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().default('us-east-1'),

  REDIS_URL: z.url().default('redis://localhost:6379'),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_USERNAME: z.string().optional(),

  IDENTITY_PROVIDER_TOKEN_ISSUER: z.url(),
  IDENTITY_PROVIDER_TOKEN_AUDIENCE: z.string().min(1),
});

export const environment = environmentSchema.parse(process.env);
