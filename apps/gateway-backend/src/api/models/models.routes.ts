import { createRoute } from '@hono/zod-openapi';
import { httpError } from '@repo/core';
import { authorize, bearerSecurity, validatedProtectedRouteErrors } from '@repo/hono';
import { SCOPES } from '../../authorization';
import Schemas from './models.schemas';

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
  path: '/models/providers',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.modelsRead] })],
  request: {
    query: Schemas.listProviders.query,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Catalog retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.listProviders.response,
        },
      },
    },
  },
});

export default { getModel, listModels, listProviders };
