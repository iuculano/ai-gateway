import { createRoute } from '@hono/zod-openapi';
import Schemas from './health.schemas';

const livez = createRoute({
  method: 'get' as const,
  path: '/livez',
  responses: {
    200: {
      description: 'Service liveliness status',
      content: {
        'application/json': {
          schema: Schemas.livez.response,
        },
      },
    },
  },
});

const readyz = createRoute({
  method: 'get' as const,
  path: '/readyz',
  responses: {
    200: {
      description: 'Service is healthy',
      content: {
        'application/json': {
          schema: Schemas.readyz.response,
        },
      },
    },
    503: {
      description: 'One or more dependencies are failing',
      content: {
        'application/json': {
          schema: Schemas.readyz.response,
        },
      },
    },
  },
});

export default {
  livez,
  readyz,
};
