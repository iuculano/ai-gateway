import { OpenAPIHono } from '@hono/zod-openapi';
import Routes from './health.routes';
import Services from './health.services';
import { zodExceptionHook } from '@repo/hono';


const app = new OpenAPIHono({ defaultHook: zodExceptionHook });

/**
 * GET /livez
 * Controller to handle liveliness checks.
 *
 * @returns
 * - 200 on success.
 */
app.openapi(Routes.livez, async (c) => {
  return c.json({
    status: 'alive' as const ,
  }, 200);
});

/**
 * GET /healthz
 * Controller to handle health checks.
 *
 * @returns
 * - 200 on success.
 */
app.openapi(Routes.healthz, async (c) => {
  return c.json({
    status: 'ok' as const,
  }, 200);
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
  // List of tables to check existence of.
  const tables = ['logs', 'models', 'organizations', 'prompts', 'routers', 'webhooks'];

  const checks = {
    db: await Services.checkPostgres(),
    db_tables: await Services.checkPostgresTables(tables),
    redis: await Services.checkRedis(),
  };

  const allHealthy = Object.values(checks).every(Boolean);

  return c.json({
    status: allHealthy ? 'ok' as const : 'degraded' as const,
    checks,
  },
  allHealthy ? 200 : 503);
});

export default app;
