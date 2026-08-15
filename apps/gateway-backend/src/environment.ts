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

  // Read by @repo/drizzle's client and by drizzle.config.ts. Validated here so
  // a missing value fails the boot by name, rather than as a bare throw from
  // inside the package on first query. No default on purpose - a wrong
  // database is worse than no database.
  POSTGRES_CONNECTION_STRING: z.url(),

  // Object storage for log payloads. Read by src/object-storage.ts rather than
  // by Bun's implicit S3 env lookup, so a missing value fails the boot by name
  // like everything else here instead of on the first log write.
  //
  // No defaults on the credentials or the bucket: writing prompts to the wrong
  // bucket is worse than not writing them at all.
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  // Omit for real AWS; set it for MinIO and other S3-compatible stores.
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().default('us-east-1'),

  REDIS_URL: z.url().default('redis://localhost:6379'),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_USERNAME: z.string().optional(),

  IDENTITY_PROVIDER_TYPE: z.enum(['zitadel']).default('zitadel'),
  IDENTITY_PROVIDER_TOKEN_ISSUER: z.url(),
  // No default on purpose: a made-up audience can never match a real token,
  // so a missing value should fail the boot, not every request.
  IDENTITY_PROVIDER_TOKEN_AUDIENCE: z.string().min(1),
});

export const environment = environmentSchema.parse(process.env);
