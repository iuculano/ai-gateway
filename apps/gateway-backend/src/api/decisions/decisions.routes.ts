import { createRoute } from '@hono/zod-openapi';
import { httpError } from '@repo/core';
import { authorize, bearerSecurity, validatedProtectedRouteErrors } from '@repo/hono';
import { SCOPES } from '../../authorization';
import Schemas from './decisions.schemas';

const createDecision = createRoute({
  method: 'post' as const,
  path: '/decisions',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.decisionsWrite] })],
  request: {
    headers: Schemas.createDecision.headers,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.createDecision.body,
        },
      },
    },
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Decision successfully decided', //
      headers: Schemas.responseHeaders,
      content: {
        'application/json': {
          schema: Schemas.createDecision.response,
        },
      },
    },
    401: {
      description: 'Gateway authentication failed, or the upstream provider rejected the supplied API key',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
    404: {
      description: 'The requested model is not registered in the catalog',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
    502: {
      description: 'The upstream provider failed',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
    504: {
      description: 'The upstream provider timed out',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

export default {
  createDecision,
};
