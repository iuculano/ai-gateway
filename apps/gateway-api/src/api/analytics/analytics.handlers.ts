import { OpenAPIHono } from '@hono/zod-openapi';
import Routes from './analytics.routes';
import Service from './analytics.services';


const app = new OpenAPIHono();

app.openapi(Routes.postAnalytics, async (c) => {
  let data = c.req.valid('json');

  const result = await Service.queryAnalytics(data);

  return c.json(result, 200);
});

export default app;
