import { createRoute } from '@hono/zod-openapi';
import { httpError } from '@repo/core';
import { authorize } from '@repo/hono';
import { bearerSecurity, validatedProtectedRouteErrors } from '../../../../../packages/hono/src/openapi/route-helpers';
import { SCOPES } from '../../authorization';
import Schemas from './models.schemas';

/**
 * Every deliberate failure the handlers can answer with is declared here.
 *
 * Throwing an HTTPException at runtime puts nothing in the generated document,
 * so these have to be kept in step with the mappers in models.handlers.ts by
 * hand - tests/unit/models.test.ts is what checks that they are.
 */
const notFound = {
  description: 'Model not found',
  content: {
    'application/json': {
      schema: httpError,
    },
  },
};

const internalServerError = {
  description: 'Internal server error',
  content: {
    'application/json': {
      schema: httpError,
    },
  },
};

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
    404: notFound,
    500: internalServerError,
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
    500: internalServerError,
  },
});

// Write is separated from read deliberately: `models` is one global catalogue
// with no organization_id, so unlike every other write in this API a change
// here is not confined to the caller's tenant - and the costs it carries are
// the billing inputs. See ROLE_SCOPES_MAP, which grants read to `user` and
// write only to `admin`.
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
    500: internalServerError,
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
    404: notFound,
    500: internalServerError,
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
    404: notFound,
    500: internalServerError,
  },
});

export default {
  getModel,
  listModels,
  createModel,
  updateModel,
  deleteModel,
};
