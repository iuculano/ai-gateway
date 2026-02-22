import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './schemas.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_USERNAME ?? 'postgres',
    password: process.env.POSTGRES_PASSWORD ?? 'postgres',
    database: process.env.POSTGRES_DATABASE ?? 'ai_gateway',
    ssl: false,
  },
  breakpoints: true,
  strict: true,
  verbose: true,
});
