import { createRoute } from '@hono/zod-openapi';
import Schemas from './models.schemas';


const getModel = createRoute({
  method: 'get' as const,
  path: '/models/:id',
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
  method: 'get' as const,
  path: '/models',
  request: {
    query: Schemas.listModelsRequest
  },
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

const createModel = createRoute({
  method: 'post' as const,
  path: '/models',
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.createModelRequest,
        },
      },
    }
  },
  responses: {
    201: {
      description: 'Model created successfully',
      content: {
        'application/json': {
          schema: Schemas.createModelResponse,
        },
      },
    },
  },
});

export default {
  getModel,
  listModels,
  createModel,
}
