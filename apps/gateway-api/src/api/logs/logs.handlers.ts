import { OpenAPIHono } from '@hono/zod-openapi';
import Routes from './logs.routes';
import Service from './logs.services';
import { zodExceptionHook } from '../../middleware/error-handler';


const app = new OpenAPIHono({ defaultHook: zodExceptionHook });

app.openapi(Routes.getLog, async (c) => {
  const params = c.req.valid('param');
  const result = await Service.getLog(params.id);

  return c.json(result, 200);
});

app.openapi(Routes.getLogData, async (c) => {
  const params = c.req.valid('param');
  const result = await Service.getLogData(params.id);

  return c.json(result, 200);
});


app.openapi(Routes.listLogs, async (c) => {
  const query = c.req.valid('query');
  const result = await Service.listLogs(query);

  return c.json(result, 200);
});

app.openapi(Routes.createLog, async (c) => {
  const json = c.req.valid('json');
  const result = await Service.createLog(json);

  return c.json(result, 201);
});

app.openapi(Routes.updateLog, async (c) => {
  const params = c.req.valid('param');
  const json = c.req.valid('json');
  const result = await Service.updateLog(params.id, json);  

  return c.json(result, 200);
});

export default app;
