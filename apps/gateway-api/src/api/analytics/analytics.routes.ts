import { createRoute } from '@hono/zod-openapi';
import Schemas from './analytics.schemas';


const postAnalytics = createRoute({
  method: 'post',
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
      description: 'Inference request submitted',
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
