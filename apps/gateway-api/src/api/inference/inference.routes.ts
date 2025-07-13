import { createRoute } from '@hono/zod-openapi';
import Schemas from './inference.schemas';


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
  },
});

export default {
  postInference,
}
