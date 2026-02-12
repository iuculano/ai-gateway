import { createRoute } from '@hono/zod-openapi';
import Schemas from './models.schemas';


const getModel = createRoute({
  method: 'get' as const,
  path: '/models/:id',
  request: {
    params: Schemas.getModel.params,
  },
  responses: {
    200: {
      description: 'Model retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.getModel.response,
        },
      },
    },
  },
});

const listModels = createRoute({
  method: 'get' as const,
  path: '/models',
  request: {
    query: Schemas.listModels.query
  },
  responses: {
    200: {
      description: 'Models retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.listModels.response,
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
          schema: Schemas.createModel.body,
        },
      },
    }
  },
  responses: {
    201: {
      description: 'Model created successfully',
      content: {
        'application/json': {
          schema: Schemas.createModel.response,
        },
      },
    },
  },
});

const updateModel = createRoute({
  method: 'patch' as const,
  path: '/models/:id',
  request: {
    params: Schemas.getModel.params,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.updateModel.body,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Logs retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.updateModel.response,
        },
      },
    },
  },
});

const deleteModel = createRoute({
  method: 'delete' as const,
  path: '/models/:id',
  request: {
    params: Schemas.deleteModel.params,
  },
  responses: {
    204: {
      description: 'Model deleted successfully',
    },
  },
});

export default {
  getModel,
  listModels,
  createModel,
  updateModel,
  deleteModel,
};
