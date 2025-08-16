import { z } from '@hono/zod-openapi'


const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().regex(/^\d+$/).default('3000'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'trace']).default('info'),

  POSTGRES_URL: z.string().url().default('postgresql://localhost:5432'),
  POSTGRES_DATABASE: z.string().default('ai_gateway'),
  POSTGRES_USERNAME: z.string().default('postgres'),
  POSTGRES_PASSWORD: z.string().default('postgres'),

  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_USERNAME: z.string().optional(),
  REDIS_DB: z.number().int().optional(),

  S3_ENDPOINT: z.string().url().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_BUCKET: z.string().optional(),

  // Unsupported
  AZURE_BLOB_ENDPOINT: z.string().url().optional(),  // e.g., "https://some-account.blob.core.windows.net"
  AZURE_STORAGE_ACCOUNT_NAME: z.string().optional(), // e.g., "some-account"
  AZURE_STORAGE_ACCOUNT_KEY: z.string().optional(),
  AZURE_BLOB_CONTAINER: z.string().optional(),
});

export const environment = environmentSchema.parse(process.env);
