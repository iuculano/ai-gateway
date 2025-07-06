import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema/**/*.ts',
  out: './src/db/migrations',
  dialect: "postgresql",
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
  strict: true,
  verbose: true,
});
