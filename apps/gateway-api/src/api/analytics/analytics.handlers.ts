import { OpenAPIHono } from '@hono/zod-openapi';
import Routes from './analytics.routes';
import Services from './analytics.services';
import { zodExceptionHook } from '../../middleware/error-handler';


const app = new OpenAPIHono({ defaultHook: zodExceptionHook });

app.openapi(Routes.postAnalytics, async (c) => {
  const body = c.req.valid('json');
  const result = await Services.queryAnalytics(body);

  return c.json(result, 200);
});

export default app;
