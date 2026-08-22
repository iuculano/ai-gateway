import { OpenAPIHono } from '@hono/zod-openapi';
import { zodExceptionHook } from '@repo/hono';
import Routes from './analytics.routes';
import Services from './analytics.services';

const app = new OpenAPIHono({ defaultHook: zodExceptionHook })
  /**
   * POST /analytics
   * Controller to handle analytics queries.
   */
  .openapi(Routes.postAnalytics, async (c) => {
    const body = c.req.valid('json');
    const result = await Services.queryAnalytics(body);

    return c.json(result, 200);
  })

  /**
   * POST /analytics/series
   * Time series and breakdowns, served from the hourly rollup.
   */
  .openapi(Routes.postAnalyticsSeries, async (c) => {
    const body = c.req.valid('json');
    const result = await Services.queryAnalyticsSeries(body);

    return c.json(result, 200);
  });

export default app;
