import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'drizzle-kit';

const configDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  schema: resolve(configDir, 'schemas/*.ts'),
  out: resolve(configDir, 'migrations'),
  dialect: 'postgresql',
  dbCredentials: {
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    password: 'postgres',
    database: 'ai_gateway',
    ssl: false,
  },
  // extensionsFilters: ["postgis"],
  // schemaFilter: "public",
  // tablesFilter: "*",
  // introspect: {
  //   casing: "camel",
  // },
  //
  // migrations: {
  //   prefix: "timestamp",
  //   table: "__drizzle_migrations__",
  //   schema: "public",
  // },

  breakpoints: true,
  verbose: true,
});
