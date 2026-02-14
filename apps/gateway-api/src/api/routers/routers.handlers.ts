import { OpenAPIHono } from '@hono/zod-openapi';
import Routes from './routers.routes';
import Services from './routers.services';
import { zodExceptionHook } from '@middleware/error-handler';


const app = new OpenAPIHono({ defaultHook: zodExceptionHook });

/**
 * GET /routers/:id
 * Retrieves a singular router by ID.
 *
 * @returns
 * - 200 OK with the router body on success.
 */
app.openapi(Routes.getRouter, async (c) => {
  const params = c.req.valid('param');
  const result = await Services.getRouter(params.id);

  return c.json(result, 200);
});

/**
 * GET /routers
 * Queries routers with optional filter for tags.
 * 
 * Supports pagination.
 *
 * @returns
 * - 200 OK with the router body on success.
 */
app.openapi(Routes.listRouters, async (c) => {
  const query = c.req.valid('query');
  const result = await Services.listRouters(query);

  return c.json(result, 200);
});

/**
 * POST /routers
 * Creates a new router.
 *
 * @returns
 * - 201 Created with the router body on success.
 */
app.openapi(Routes.createRouter, async (c) => {
  const body = c.req.valid('json');
  const result = await Services.createRouter(body);

  return c.json(result, 201);
});

/**
 * PATCH /routers/:id
 * Updates a singular prompt by ID.
 *
 * @returns
 * - 200 OK with the router body on success.
 */
app.openapi(Routes.updateRouter, async (c) => {
  const params = c.req.valid('param');
  const body = c.req.valid('json');
  const result = await Services.updateRouter(params.id, body);  

  return c.json(result, 200);
});

/**
 * DELETE /routers/:id
 * Deletes a singular router by ID.
 *
 * @returns
 * - 204 No Content on success.
 */
app.openapi(Routes.deleteRouter, async (c) => {
  const params = c.req.valid('param');
  await Services.deleteRouter(params.id);

  return c.body(null, 204);
});

