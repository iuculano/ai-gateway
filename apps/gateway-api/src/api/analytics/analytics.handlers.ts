import { OpenAPIHono } from '@hono/zod-openapi';
import Routes from './analytics.routes';
import Services from './analytics.services';
import { zodExceptionHook } from '@repo/hono';


const app = new OpenAPIHono({ defaultHook: zodExceptionHook });

/**
 * POST /analytics
 * Controller to handle analytics queries.
 *
 * @returns
 * - 200 OK with the analytics response on success.
 */
app.openapi(Routes.postAnalytics, async (c) => {
  const body = c.req.valid('json');
  const result = await Services.queryAnalytics(body);

  return c.json(result, 200);
});

export default app;
