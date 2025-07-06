import { createRoute } from '@hono/zod-openapi';
import Schemas from './inference.schemas';


const postInference = createRoute({
  method: 'post',
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
          schema: Schemas.inferenceResponseNonStreaming,
        },
      },
    },

    202: {
      description: 'Inference request submitted',
      content: {
        'application/json': {
          schema: Schemas.inferenceResponseStreaming,
        },
      },
    },
  },
});

export default {
  postInference,
}
