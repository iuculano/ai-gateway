import { OpenAPIHono } from '@hono/zod-openapi';
import Routes from './health.routes';
import Services from './health.services';
import { zodExceptionHook } from '../../middleware/error-handler';


const app = new OpenAPIHono({ defaultHook: zodExceptionHook });

app.openapi(Routes.livez, async (c) => {
  return c.json({ 
    status: 'alive' as const ,
  }, 200);
});

app.openapi(Routes.healthz, async (c) => {
  return c.json({ 
    status: 'ok' as const,
  }, 200);
});

app.openapi(Routes.readyz, async (c) => {
  const tables = ['logs', 'models', 'settings'];

  const checks = {
    db: await Services.checkPostgres(),
    db_tables: await Services.checkPostgresTables(tables),
    redis: await Services.checkRedis(),
  };

  const allHealthy = Object.values(checks).every(Boolean);

  // Watch this return type, the zod 'literal' types do truly mean a string
  // literal. You will need to cast it as const or you'll get a type error.
  return c.json({
    status: allHealthy ? 'ok' as const : 'degraded' as const,
    checks,
  }, 
  allHealthy ? 200 : 503);
});

export default app;
