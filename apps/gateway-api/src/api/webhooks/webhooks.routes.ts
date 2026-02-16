import { createRoute } from '@hono/zod-openapi';
import Schemas from './webhooks.schemas';


const getWebhook = createRoute({
  method: 'get' as const,
  path: '/webhooks/:id',
  request: {
    params: Schemas.getWebhook.params,
  },
  responses: {
    200: {
      description: 'Webhook retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.getWebhook.response,
        },
      },
    },
  },
});

const listWebhooks = createRoute({
  method: 'get' as const,
  path: '/webhooks',
  request: {
    query: Schemas.listWebhooks.query
  },
  responses: {
    200: {
      description: 'Webhooks retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.listWebhooks.response,
        },
      },
    },
  },
});

const createWebhook = createRoute({
  method: 'post' as const,
  path: '/webhooks',
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.createWebhook.body,
        },
      },
    }
  },
  responses: {
    201: {
      description: 'Webhook created successfully',
      content: {
        'application/json': {
          schema: Schemas.createWebhook.response,
        },
      },
    },
  },
});

const updateWebhook = createRoute({
  method: 'patch' as const,
  path: '/webhooks/:id',
  request: {
    params: Schemas.getWebhook.params,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.updateWebhook.body,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Webhook updated successfully',
      content: {
        'application/json': {
          schema: Schemas.updateWebhook.response,
        },
      },
    },
  },
});

const deleteWebhook = createRoute({
  method: 'delete' as const,
  path: '/webhooks/:id',
  request: {
    params: Schemas.deleteWebhook.params,
  },
  responses: {
    204: {
      description: 'Webhook deleted successfully',
    },
  },
});

//---

const listWebhookOutbox = createRoute({
  method: 'get' as const,
  path: '/webhooks/outbox',
  request: {
    query: Schemas.listWebhookOutbox.query,
  },
  responses: {
    200: {
      description: 'Webhook outbox retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.listWebhookOutbox.response,
        },
      },
    },
  },
});

export default {
  getWebhook,
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,

  listWebhookOutbox,
};
