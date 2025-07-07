import { OpenAPIHono } from '@hono/zod-openapi';
import { db } from '../../clients/drizzle';
import { nats } from '../../clients/nats';
import { redis } from '../../clients/redis';
import HealthRoutes from './health.routes';


const app = new OpenAPIHono();

app.openapi(HealthRoutes.livez, async (c) => {
  return c.json({ 
    status: 'alive' as const 
  }, 200);
});

app.openapi(HealthRoutes.healthz, async (c) => {
  return c.json({ 
    status: 'ok' as const 
  }, 200);
});

app.openapi(HealthRoutes.readyz, async (c) => {
  const checks = {
    db: false,
    redis: false,
    nats: false,
  };

  // Just try to do some kind of no-op to find a sign of life.
  try {
    await db.execute('SELECT 1');
    checks.db = true;

    await redis.ping();
    checks.redis = true;

    await nats.flush();
    checks.nats = true;
  } 
  
  catch {
    // Bailing is enough, we'll fail below.
  }

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
