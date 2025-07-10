import { createRoute } from '@hono/zod-openapi';
import Schemas from './analytics.schemas';


const postAnalytics = createRoute({
  method: 'post' as const,
  path: '/analytics',
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.analyticsRequest,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Sucessful analytics query',
      content: {
        'application/json': {
          schema: Schemas.analyticsResponse,
        },
      },
    },
  },
});

export default {
  postAnalytics,
}
