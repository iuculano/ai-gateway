import { createRoute } from '@hono/zod-openapi';
import { httpError } from '@repo/core';
import { authorize } from '@repo/hono';
import { bearerSecurity, validatedProtectedRouteErrors } from '../../../../../packages/hono/src/openapi/route-helpers';
import { SCOPES } from '../../authorization';
import Schemas from './webhooks.schemas';

const getWebhook = createRoute({
  method: 'get' as const,
  path: '/webhooks/{id}',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.webhooksRead] })],
  request: {
    params: Schemas.getWebhook.params,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Webhook retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.getWebhook.response,
        },
      },
    },
    404: {
      description: 'Webhook not found',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

const listWebhooks = createRoute({
  method: 'get' as const,
  path: '/webhooks',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.webhooksRead] })],
  request: {
    query: Schemas.listWebhooks.query,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Webhooks retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.listWebhooks.response,
        },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

const createWebhook = createRoute({
  method: 'post' as const,
  path: '/webhooks',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.webhooksWrite] })],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.createWebhook.body,
        },
      },
    },
  },
  responses: {
    ...validatedProtectedRouteErrors,
    201: {
      description: 'Webhook created successfully',
      content: {
        'application/json': {
          schema: Schemas.createWebhook.response,
        },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

const updateWebhook = createRoute({
  method: 'patch' as const,
  path: '/webhooks/{id}',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.webhooksWrite] })],
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
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Webhook updated successfully',
      content: {
        'application/json': {
          schema: Schemas.updateWebhook.response,
        },
      },
    },
    404: {
      description: 'Webhook not found',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

const deleteWebhook = createRoute({
  method: 'delete' as const,
  path: '/webhooks/{id}',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.webhooksWrite] })],
  request: {
    params: Schemas.deleteWebhook.params,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    204: {
      description: 'Webhook deleted successfully',
    },
    404: {
      description: 'Webhook not found',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

//---

const listWebhookOutbox = createRoute({
  method: 'get' as const,
  path: '/webhooks/outbox',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.webhooksRead] })],
  request: {
    query: Schemas.listWebhookOutbox.query,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Webhook outbox retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.listWebhookOutbox.response,
        },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

const listWebhookDeliveries = createRoute({
  method: 'get' as const,
  path: '/webhooks/deliveries',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.webhooksRead] })],
  request: {
    query: Schemas.listWebhookDeliveries.query,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Webhook deliveries retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.listWebhookDeliveries.response,
        },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: httpError,
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
  listWebhookDeliveries,
};
