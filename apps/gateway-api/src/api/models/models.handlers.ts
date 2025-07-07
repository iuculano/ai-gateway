import { OpenAPIHono } from '@hono/zod-openapi';
import Routes from './models.routes';
import Service from './models.services';


const app = new OpenAPIHono();

app.openapi(Routes.getModel, async (c) => {
  const params = c.req.valid('param');
  const result = await Service.getModel(params);

  return c.json(result, 200);
});

app.openapi(Routes.listModels, async (c) => {
  const query = c.req.valid('query');
  const result = await Service.listModels(query);

  return c.json(result, 200);
});

export default app;
