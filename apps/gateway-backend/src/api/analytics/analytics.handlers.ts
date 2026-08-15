import { OpenAPIHono } from '@hono/zod-openapi';
import { zodExceptionHook } from '@repo/hono';
import Routes from './analytics.routes';
import Services from './analytics.services';

const app = new OpenAPIHono({ defaultHook: zodExceptionHook })
  /**
   * POST /analytics
   * Controller to handle analytics queries.
   *
   * @returns
   * - 200 OK with the analytics response on success.
   */
  .openapi(Routes.postAnalytics, async (c) => {
    const body = c.req.valid('json');
    const result = await Services.queryAnalytics(body);

    return c.json(result, 200);
  });

export default app;
