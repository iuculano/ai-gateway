import { createRoute } from '@hono/zod-openapi';
import Schemas from './routers.schemas';


const getRouter = createRoute({
  method: 'get' as const,
  path: '/routers/:id',
  request: {
    params: Schemas.getRouter.params,
  },
  responses: {
    200: {
      description: 'Router retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.getRouter.response,
        },
      },
    },
  },
});

const listRouters = createRoute({
  method: 'get' as const,
  path: '/routers',
  request: {
    query: Schemas.listRouters.query,
  },
  responses: {
    200: {
      description: 'Routers retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.listRouters.response,
        },
      },
    },
  },
});

const createRouter = createRoute({
  method: 'post' as const,
  path: '/routers',
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.createRouter.body,
        },
      },
    }
  },
  responses: {
    201: {
      description: 'Router created successfully',
      content: {
        'application/json': {
          schema: Schemas.createRouter.response,
        },
      },
    },
  },
});

const updateRouter = createRoute({
  method: 'patch' as const,
  path: '/routers/:id',
  request: {
    params: Schemas.updateRouter.params,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.updateRouter.body,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Router updated successfully',
      content: {
        'application/json': {
          schema: Schemas.updateRouter.response,
        },
      },
    },
  },
});

const deleteRouter = createRoute({
  method: 'delete' as const,
  path: '/routers/:id',
  request: {
    params: Schemas.deleteRouter.params,
  },
  responses: {
    204: {
      description: 'Router deleted successfully',
    },
  },
});


export default {
  getRouter,
  listRouters,
  createRouter,
  updateRouter,
  deleteRouter,
}
