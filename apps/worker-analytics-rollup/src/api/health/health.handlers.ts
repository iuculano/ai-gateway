import { defineOpenAPIRoute, OpenAPIHono } from '@hono/zod-openapi';
import { zodExceptionHook } from '@repo/hono';
import Routes from './health.routes';
import Services from './health.services';

// Both, because this worker is only useful when it can read one and write
// the other. `analytics_hourly` missing is the interesting failure: it means
// db:push has not run and every tick would throw.
const requiredTables = ['logs', 'analytics_hourly'];

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
