import { OpenAPIHono } from '@hono/zod-openapi';
import Routes from './logs.routes';
import Service from './logs.services';
import { zodExceptionHook } from '../../middleware/error-handler';


const app = new OpenAPIHono({ defaultHook: zodExceptionHook });

/**
 * GET /logs/:id
 * Controller to handle retrieving a specific log.
 *
 * @returns
 * - 200 on success.
 */
app.openapi(Routes.getLog, async (c) => {
  const params = c.req.valid('param');
  const result = await Service.getLog(params.id);

  return c.json(result, 200);
});

/**
 * GET /logs/:id/data
 * Controller to handle retrieving specific log data.
 *
 * @returns
 * - 200 on success.
 */
app.openapi(Routes.getLogData, async (c) => {
  const params = c.req.valid('param');
  const result = await Service.getLogData(params.id);

  return c.json(result, 200);
});

/**
 * GET /logs
 * Controller to handle retrieving a list of logs.
 *
 * @returns
 * - 200 on success.
 */
app.openapi(Routes.listLogs, async (c) => {
  const query = c.req.valid('query');
  const result = await Service.listLogs(query);

  return c.json(result, 200);
});

/**
 * POST /logs
 * Controller to handle creating a new log.
 *
 * @returns
 * - 201 on success.
 */
app.openapi(Routes.createLog, async (c) => {
  const json = c.req.valid('json');
  const result = await Service.createLog(json);

  return c.json(result, 201);
});

/**
 * PATCH /logs/:id
 * Controller to handle updating an existing log.
 *
 * @returns
 * - 200 on success.
 */
app.openapi(Routes.updateLog, async (c) => {
  const params = c.req.valid('param');
  const json = c.req.valid('json');
  const result = await Service.updateLog(params.id, json);  

  return c.json(result, 200);
});

/**
 * DELETE /logs/:id
 * Controller to handle deletion of an existing log.
 *
 * @returns
 * - 204 on success.
 */
app.openapi(Routes.deleteLog, async (c) => {
  const params = c.req.valid('param');
  await Service.deleteLog(params.id);  

  return c.body(null, 204);
});

export default app;
