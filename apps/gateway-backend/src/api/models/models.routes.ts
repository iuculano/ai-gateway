import { createRoute } from '@hono/zod-openapi';
import { authorize, bearerSecurity, validatedProtectedRouteErrors } from '@repo/hono';
import { SCOPES } from '../../authorization';
import Schemas from './models.schemas';
import { httpError } from '@repo/core';


const getModel = createRoute({
  method: 'get' as const,
  path: '/models/{id}',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.modelsRead] })],
  request: {
    params: Schemas.getModel.params,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Model retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.getModel.response,
        },
      },
    },
    404: {
      description: 'Model not found',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

const listModels = createRoute({
  method: 'get' as const,
  path: '/models',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.modelsRead] })],
  request: {
    query: Schemas.listModels.query,
  },
  responses: {
    ...validatedProtectedRouteErrors,
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

const listProviders = createRoute({
  method: 'get' as const,
  path: '/providers',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.modelsRead] })],
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Catalogue retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.listProviders.response,
        },
      },
    },
  },
});

const createModel = createRoute({
  method: 'post' as const,
  path: '/models',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.modelsWrite] })],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.createModel.body,
        },
      },
    },
  },
  responses: {
    ...validatedProtectedRouteErrors,
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
  path: '/models/{id}',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.modelsWrite] })],
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
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Model updated successfully',
      content: {
        'application/json': {
          schema: Schemas.updateModel.response,
        },
      },
    },
    404: {
      description: 'Model not found',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

const deleteModel = createRoute({
  method: 'delete' as const,
  path: '/models/{id}',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.modelsWrite] })],
  request: {
    params: Schemas.deleteModel.params,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    204: {
      description: 'Model deleted successfully',
    },
    404: {
      description: 'Model not found',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

export default {
  getModel,
  listModels,
  listProviders,
  createModel,
  updateModel,
  deleteModel,
};
