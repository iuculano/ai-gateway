import { createRoute } from '@hono/zod-openapi';
import Schemas from './inference.schemas';
import { httpError } from '@repo/core';


const postInference = createRoute({
  method: 'post' as const,
  path: '/inference',
  request: {
    headers: Schemas.inferenceHeaders,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.inferenceRequest,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Inference request submitted',
      content: {
        'application/json': {
          schema: Schemas.inferenceResponse,
        },

        'application/event-stream': {
          schema: Schemas.inferenceResponse,
        },
      },
    },
    429: {
      description: 'Rate limit exceeded',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
    503: {
      description: 'Service unavailable',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

export default {
  postInference,
}
