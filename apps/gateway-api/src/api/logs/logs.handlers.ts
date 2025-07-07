import { OpenAPIHono } from '@hono/zod-openapi';
import Routes from './logs.routes';
import Service from './logs.services';


const app = new OpenAPIHono();

app.openapi(Routes.getLogs, async (c) => {
  const data = c.req.valid('query');

  const result = await Service.queryLogs(data);

  return c.json(result, 200);
});

export default app;
