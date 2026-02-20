import { createRoute } from '@hono/zod-openapi';
import Schemas from './api-keys.schemas';


const getApiKey = createRoute({
  method: 'get' as const,
  path: '/api-keys/:id',
  request: {
    params: Schemas.getApiKey.params,
  },
  responses: {
    200: {
      description: 'API key retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.getApiKey.response,
        },
      },
    },
  },
});

const listApiKeys = createRoute({
  method: 'get' as const,
  path: '/api-keys',
  request: {
    query: Schemas.listApiKeys.query
  },
  responses: {
    200: {
      description: 'API keys retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.listApiKeys.response,
        },
      },
    },
  },
});

const createApiKey = createRoute({
  method: 'post' as const,
  path: '/api-keys',
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.createApiKey.body,
        },
      },
    }
  },
  responses: {
    201: {
      description: 'API key created successfully',
      content: {
        'application/json': {
          schema: Schemas.createApiKey.response,
        },
      },
    },
  },
});

const updateApiKey = createRoute({
  method: 'patch' as const,
  path: '/api-keys/:id',
  request: {
    params: Schemas.getApiKey.params,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.updateApiKey.body,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'API key updated successfully',
      content: {
        'application/json': {
          schema: Schemas.updateApiKey.response,
        },
      },
    },
  },
});

const deleteApiKey = createRoute({
  method: 'delete' as const,
  path: '/api-keys/:id',
  request: {
    params: Schemas.deleteApiKey.params,
  },
  responses: {
    204: {
      description: 'API key deleted successfully',
    },
  },
});

export default {
  getApiKey,
  listApiKeys,
  createApiKey,
  updateApiKey,
  deleteApiKey,

}
