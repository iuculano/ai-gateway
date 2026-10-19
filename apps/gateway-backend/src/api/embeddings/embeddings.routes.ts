import { createRoute } from '@hono/zod-openapi';
import { httpError } from '@repo/core';
import { authorize, bearerSecurity, validatedProtectedRouteErrors } from '@repo/hono';
import { SCOPES } from '../../authorization';
import Schemas from './embeddings.schemas';

const createEmbedding = createRoute({
  method: 'post' as const,
  path: '/embeddings',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.embeddingsWrite] })],
  request: {
    headers: Schemas.createEmbedding.headers,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.createEmbedding.body,
        },
      },
    },
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Embeddings created',
      headers: Schemas.responseHeaders,
      content: {
        'application/json': {
          schema: Schemas.createEmbedding.response,
        },
      },
    },
    401: {
      description: 'Gateway authentication failed, or the upstream provider rejected the supplied ai-api-key',
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
    429: {
      description: 'Rate limit exceeded upstream',
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
  createEmbedding,
};
