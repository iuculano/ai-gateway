import { defineConfig } from 'drizzle-kit';

const connectionString = process.env.POSTGRES_ADMIN_CONNECTION_STRING;
if (!connectionString) {
  throw new Error(
    'Missing POSTGRES_ADMIN_CONNECTION_STRING. Pass it inline, for example:\n' +
      '  POSTGRES_ADMIN_CONNECTION_STRING=postgresql://postgres:postgres@host.docker.internal:5432/ai_gateway bun run db:push',
  );
}

export default defineConfig({
  schema: './schemas.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: connectionString,
  },
  breakpoints: true,
  verbose: true,
});
