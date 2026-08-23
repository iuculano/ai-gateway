import { defineOpenAPIRoute, OpenAPIHono } from '@hono/zod-openapi';
import { assertNever } from '@repo/core';
import { zodExceptionHook } from '@repo/hono';
import { HTTPException } from 'hono/http-exception';
import Routes from './webhooks.routes';
import Services, {
  type DeleteWebhookFailure,
  type GetWebhookFailure,
  type UpdateWebhookFailure,
} from './webhooks.services';

/**
 * The HTTP translations, one per service failure union.
 */
function toGetWebhookHttpException(failure: GetWebhookFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'WEBHOOK_NOT_FOUND':
      return new HTTPException(404);

    default:
      return assertNever(code);
  }
}

function toUpdateWebhookHttpException(failure: UpdateWebhookFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'WEBHOOK_NOT_FOUND':
      return new HTTPException(404);

    default:
      return assertNever(code);
  }
}

function toDeleteWebhookHttpException(failure: DeleteWebhookFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'WEBHOOK_NOT_FOUND':
      return new HTTPException(404);

    default:
      return assertNever(code);
  }
}

/**
 * GET /webhooks/outbox
 * Retrieve the pending webhook outbox.
 */
const listWebhookOutbox = defineOpenAPIRoute({
  route: Routes.listWebhookOutbox,
  handler: async (c) => {
    const query = c.req.valid('query');
    const result = await Services.listWebhookOutbox(query);

    return c.json(result, 200);
  },
});

/**
 * GET /webhooks/deliveries
 * Retrieve delivery attempts across all webhooks.
 */
const listWebhookDeliveries = defineOpenAPIRoute({
  route: Routes.listWebhookDeliveries,
  handler: async (c) => {
    const query = c.req.valid('query');
    const result = await Services.listWebhookDeliveries(query);

    return c.json(result, 200);
  },
});

/**
 * GET /webhooks/:id
 * Retrieve a specific webhook by id.
 */
const getWebhook = defineOpenAPIRoute({
  route: Routes.getWebhook,
  handler: async (c) => {
    const params = c.req.valid('param');
    const result = await Services.getWebhook(params.id);

    return result.match(
      (webhook) => c.json(webhook, 200),
      (failure) => {
        throw toGetWebhookHttpException(failure);
      },
    );
  },
});

/**
 * GET /webhooks
 * Retrieve a list of webhooks.
 */
const listWebhooks = defineOpenAPIRoute({
  route: Routes.listWebhooks,
  handler: async (c) => {
    const query = c.req.valid('query');
    const result = await Services.listWebhooks(query);

    return c.json(result, 200);
  },
});

/**
 * POST /webhooks
 * Create a new webhook.
 */
const createWebhook = defineOpenAPIRoute({
  route: Routes.createWebhook,
  handler: async (c) => {
    const body = c.req.valid('json');
    const result = await Services.createWebhook(body);

    return c.json(result, 201);
  },
});

/**
 * PATCH /webhooks/:id
 * Update an existing webhook.
 */
const updateWebhook = defineOpenAPIRoute({
  route: Routes.updateWebhook,
  handler: async (c) => {
    const params = c.req.valid('param');
    const body = c.req.valid('json');

    const result = await Services.updateWebhook(params.id, body);

    return result.match(
      (updated) => c.json(updated, 200),
      (failure) => {
        throw toUpdateWebhookHttpException(failure);
      },
    );
  },
});

/**
 * DELETE /webhooks/:id
 * Delete an existing webhook.
 */
const deleteWebhook = defineOpenAPIRoute({
  route: Routes.deleteWebhook,
  handler: async (c) => {
    const params = c.req.valid('param');
    const result = await Services.deleteWebhook(params.id);

    return result.match(
      () => c.body(null, 204),
      (failure) => {
        throw toDeleteWebhookHttpException(failure);
      },
    );
  },
});

// Order matters - Hono matches in registration order. The two static paths have
// to come before `/webhooks/:id` or `:id` swallows `outbox` and `deliveries`.
const app = new OpenAPIHono({ defaultHook: zodExceptionHook }).openapiRoutes([
  listWebhookOutbox,
  listWebhookDeliveries,
  getWebhook,
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
] as const);

export default app;
