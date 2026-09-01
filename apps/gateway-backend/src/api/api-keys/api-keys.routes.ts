import { createRoute } from '@hono/zod-openapi';
import { httpError } from '@repo/core';
import { authorize, bearerSecurity, validatedProtectedRouteErrors } from '@repo/hono';
import { SCOPES } from '../../authorization';
import Schemas from './api-keys.schemas';

const getApiKey = createRoute({
  method: 'get' as const,
  path: '/api-keys/{id}',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.apiKeysRead] })],
  request: {
    params: Schemas.getApiKey.params,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'API key retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.getApiKey.response,
        },
      },
    },
    404: {
      description: 'API key not found',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

const getApiKeyStats = createRoute({
  method: 'get' as const,
  path: '/api-keys/{id}/stats',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.apiKeysRead] })],
  request: {
    params: Schemas.getApiKey.params,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'API key statistics retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.getApiKeyStats.response,
        },
      },
    },
    404: {
      description: 'API key not found',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

const listApiKeys = createRoute({
  method: 'get' as const,
  path: '/api-keys',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.apiKeysRead] })],
  request: {
    query: Schemas.listApiKeys.query,
  },
  responses: {
    ...validatedProtectedRouteErrors,
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
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.apiKeysWrite], actorTypes: ['user'] })],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.createApiKey.body,
        },
      },
    },
  },
  responses: {
    ...validatedProtectedRouteErrors,
    201: {
      description: 'API key created successfully.',
      content: {
        'application/json': {
          schema: Schemas.createApiKey.response,
        },
      },
    },
    403: {
      description: 'Only user callers may create keys, and they may grant only scopes they hold themselves',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

const updateApiKey = createRoute({
  method: 'patch' as const,
  path: '/api-keys/{id}',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.apiKeysWrite], actorTypes: ['user'] })],
  request: {
    params: Schemas.updateApiKey.params,
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
    ...validatedProtectedRouteErrors,
    200: {
      description: 'API key updated successfully',
      content: {
        'application/json': {
          schema: Schemas.updateApiKey.response,
        },
      },
    },
    403: {
      description: 'Only user callers may update keys, and they may grant only scopes they hold themselves',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
    404: {
      description: 'API key not found',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
    409: {
      description: 'The API key has been revoked and can no longer be updated',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

const revokeApiKey = createRoute({
  method: 'delete' as const,
  path: '/api-keys/{id}',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.apiKeysWrite], actorTypes: ['user'] })],
  request: {
    params: Schemas.revokeApiKey.params,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    204: {
      // Revocation is idempotent: revoking an already revoked key answers with
      // this too, rather than a conflict.
      description: 'API key revoked successfully',
    },
    404: {
      description: 'API key not found',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

export default {
  getApiKey,
  getApiKeyStats,
  listApiKeys,
  createApiKey,
  updateApiKey,
  revokeApiKey,
};
