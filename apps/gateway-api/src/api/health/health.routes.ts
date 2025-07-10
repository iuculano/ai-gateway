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
          schema: Schemas.livezResponse,
        },
      },
    },
  },
});

const healthz = createRoute({
  method: 'get' as const,
  path: '/healthz',
  responses: {
    200: {
      description: 'Service health status',
      content: {
        'application/json': {
          schema: Schemas.healthzResponse,
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
          schema: Schemas.readyzResponse,
        },
      },
    },
    503: {
      description: 'One or more dependencies are failing',
      content: {
        'application/json': {
          schema: Schemas.readyzResponse,
        },
      },
    },
  },
});

export default {
  livez,
  healthz,
  readyz,
}
