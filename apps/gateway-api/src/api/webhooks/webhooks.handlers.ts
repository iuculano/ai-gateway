import { OpenAPIHono } from '@hono/zod-openapi';
import Routes from './webhooks.routes';
import Service from './webhooks.services';
import { zodExceptionHook } from '../../middleware/error-handler';


const app = new OpenAPIHono({ defaultHook: zodExceptionHook });

/**
 * GET /webhooks/:id
 * Controller to handle retrieving a specific webhook.
 *
 * @returns
 * - 200 OK with the webhook response on success.
 */
app.openapi(Routes.getWebhook, async (c) => {
  const params = c.req.valid('param');
  const result = await Service.getWebhook(params.id);

  return c.json(result, 200);
});

/**
 * GET /webhooks
 * Controller to handle retrieving a list of webhooks.
 *
 * @returns
 * - 200 OK with the webhook response on success.
 */
app.openapi(Routes.listWebhooks, async (c) => {
  const query = c.req.valid('query');
  const result = await Service.listWebhooks(query);

  return c.json(result, 200);
});

/**
 * POST /webhooks
 * Controller to handle creating a new webhook.
 *
 * @returns
 * - 201 Created with the webhook response on success.
 */
app.openapi(Routes.createWebhook, async (c) => {
  const json = c.req.valid('json');
  const result = await Service.createWebhook(json);

  return c.json(result, 201);
});

/**
 * PATCH /webhooks/:id
 * Controller to handle updating an existing webhook.
 *
 * @returns
 * - 200 OK with the updated webhook on success.
 */
app.openapi(Routes.updateWebhook, async (c) => {
  const params = c.req.valid('param');
  const json = c.req.valid('json');
  const result = await Service.updateWebhook(params.id, json);

  return c.json(result, 200);
});

/**
 * DELETE /webhooks/:id
 * Controller to handle deletion of an existing webhook.
 *
 * @returns
 * - 204 No Content on success.
 */
app.openapi(Routes.deleteWebhook, async (c) => {
  const params = c.req.valid('param');
  await Service.deleteWebhook(params.id);

  return c.body(null, 204);
});

app.openapi(Routes.listWebhookOutbox, async (c) => {
  const params = c.req.valid('param');
  const result = await Service.listWebhookOutbox(params.id);

  return c.json(result, 200);
});

export default app;
