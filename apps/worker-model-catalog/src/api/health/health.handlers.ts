import { OpenAPIHono } from '@hono/zod-openapi';
import { zodExceptionHook } from '@repo/hono';
import Routes from './health.routes';
import Services from './health.services';

const app = new OpenAPIHono({ defaultHook: zodExceptionHook });

/**
 * GET /livez
 * Controller to handle liveliness checks.
 *
 * @returns
 * - 200 on success.
 */
app.openapi(Routes.livez, async (c) => {
  return c.json(
    {
      status: 'alive' as const,
    },
    200,
  );
});

/**
 * GET /healthz
 * Controller to handle health checks.
 *
 * @returns
 * - 200 on success.
 */
app.openapi(Routes.healthz, async (c) => {
  return c.json(
    {
      status: 'ok' as const,
    },
    200,
  );
});

/**
 * GET /readyz
 * Controller to handle readiness checks.
 *
 * @returns
 * - 200 on success.
 * - 503 if any checks fail.
 */
app.openapi(Routes.readyz, async (c) => {
  // Only what this worker touches. The wider list the other worker checks
  // includes `routers`, which no schema in @repo/drizzle declares - so that
  // readiness probe can never pass.
  const tables = ['models'];

  const checks = {
    db: await Services.checkPostgres(),
    db_tables: await Services.checkPostgresTables(tables),
  };

  const allHealthy = Object.values(checks).every(Boolean);

  return c.json(
    {
      status: allHealthy ? ('ok' as const) : ('degraded' as const),
      checks,
    },
    allHealthy ? 200 : 503,
  );
});

export default app;
