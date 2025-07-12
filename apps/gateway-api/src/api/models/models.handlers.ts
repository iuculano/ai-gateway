import { OpenAPIHono } from '@hono/zod-openapi';
import Routes from './models.routes';
import Service from './models.services';
import { zodExceptionHook } from '../../middleware/error-handler';


const app = new OpenAPIHono({ defaultHook: zodExceptionHook });

app.openapi(Routes.getModel, async (c) => {
  const params = c.req.valid('param');
  const result = await Service.getModel(params.id);

  return c.json(result, 200);
});

app.openapi(Routes.listModels, async (c) => {
  const query = c.req.valid('query');
  const result = await Service.listModels(query);

  return c.json(result, 200);
});

app.openapi(Routes.createModel, async (c) => {
  const json = c.req.valid('json');
  const result = await Service.createModel(json);

  return c.json(result, 201);
});

export default app;
