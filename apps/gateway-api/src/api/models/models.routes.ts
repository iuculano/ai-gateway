import { createRoute } from '@hono/zod-openapi';
import Schemas from './models.schemas';


const getModel = createRoute({
  method: 'get',
  path: '/models/:model_id',
  request: {
    params: Schemas.getModelRequest,
  },
  responses: {
    200: {
      description: 'Model retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.getModelResponse,
        },
      },
    },
  },
});

const listModels = createRoute({
  method: 'get',
  path: '/models',
  responses: {
    200: {
      description: 'Models retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.listModelsResponse,
        },
      },
    },
  },
});

export default {
  getModel,
  listModels,
}
