import { createRoute } from '@hono/zod-openapi';
import Schemas from './analytics.schemas';
import { httpError } from '@repo/core';

const postAnalytics = createRoute({
  method: 'post' as const,
  path: '/analytics',
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.analytics.body,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Successful analytics query',
      content: {
        'application/json': {
          schema: Schemas.analytics.response,
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
  postAnalytics,
}
