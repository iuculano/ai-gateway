import { OpenAPIHono } from '@hono/zod-openapi';
import Routes from './api-keys.routes';
import Services from './api-keys.services';
import { zodExceptionHook } from '@repo/hono';


const app = new OpenAPIHono({ defaultHook: zodExceptionHook });

/**
 * GET /api-keys/:id
 * Retrieves a singular API key by ID.
 *
 * @returns
 * - 200 OK with the API key body on success.
 */
app.openapi(Routes.getApiKey, async (c) => {
  const params = c.req.valid('param');
  const result = await Services.getApiKey(params.id);

  return c.json(result, 200);
});

/**
 * GET /api-keys
 * Queries API keys with optional filter for tags.
 *
 * Supports pagination.
 *
 * @returns
 * - 200 OK with the API keys body on success.
 */
app.openapi(Routes.listApiKeys, async (c) => {
  const query = c.req.valid('query');
  const result = await Services.listApiKeys(query);

  return c.json(result, 200);
});

/**
 * POST /api-keys
 * Creates a new API key.
 *
 * @returns
 * - 201 Created with the API key body on success.
 */
app.openapi(Routes.createApiKey, async (c) => {
  const body = c.req.valid('json');
  const result = await Services.createApiKey(body);

  return c.json(result, 201);
});

/**
 * PATCH /api-keys/:id
 * Updates a singular API key by ID.
 *
 * @returns
 * - 200 OK with the API key body on success.
 */
app.openapi(Routes.updateApiKey, async (c) => {
  const params = c.req.valid('param');
  const body = c.req.valid('json');
  const result = await Services.updateApiKey(params.id, body);

  return c.json(result, 200);
});

/**
 * DELETE /api-keys/:id
 * Deletes a singular API key by ID.
 *
 * @returns
 * - 204 No Content on success.
 */
app.openapi(Routes.deleteApiKey, async (c) => {
  const params = c.req.valid('param');
  await Services.deleteApiKey(params.id);

  return c.body(null, 204);
});

export default app;
