import { OpenAPIHono } from '@hono/zod-openapi';
import Routes from './models.routes';
import Service from './models.services';


const app = new OpenAPIHono();

app.openapi(Routes.getModel, async (c) => {
  const data = c.req.valid('param');

  const result = await Service.queryModel(data);

  return c.json(result, 200);
});

export default app;
