import { defineOpenAPIRoute, OpenAPIHono } from '@hono/zod-openapi';
import { apiKeys, auditLogs, organizations, userIdentities, users } from '@repo/drizzle/schemas';
import { zodExceptionHook } from '@repo/hono';
import { getTableName } from 'drizzle-orm';
import Routes from './health.routes';
import Services from './health.services';

// Tables that must exist for the service to be considered healthy.
//
// Read off the schema objects rather than spelled as strings: the comment here
// used to claim they were derived while the list was hard-coded, so renaming a
// table in drizzle would have left the health check green while asserting the
// presence of a table that no longer existed.
const requiredTables = [apiKeys, auditLogs, organizations, userIdentities, users].map(getTableName);

/**
 * GET /livez
 * Check if the service is alive.
 *
 * This endpoint should be considered internal.
 */
const livez = defineOpenAPIRoute({
  route: Routes.livez,
  handler: async (c) => {
    return c.json(
      {
        status: 'alive' as const,
      },
      200,
    );
  },
});

/**
 * GET /readyz
 * Check if the service is ready by verifying the health of its dependencies.
 *
 * This endpoint should be considered internal.
 */
const readyz = defineOpenAPIRoute({
  route: Routes.readyz,
  handler: async (c) => {
    const checks = {
      db: await Services.checkPostgres(),
      db_tables: await Services.checkPostgresTables(requiredTables),
      redis: await Services.checkRedis(),
    };

    const allHealthy = Object.values(checks).every(Boolean);

    return c.json(
      {
        status: allHealthy ? ('ok' as const) : ('degraded' as const),
        checks,
      },
      allHealthy ? 200 : 503,
    );
  },
});

const app = new OpenAPIHono({ defaultHook: zodExceptionHook }).openapiRoutes([livez, readyz] as const);

export default app;
